'use strict';
let requirementEnvironmentData = null;
let requirementPickerRevision = 0;
let requirementPickerTimer;
let requirementDraftSlug = '';
let requirementDraftToken = '';
let taskEditContext = null;
let taskDirectoryContext = null;
// Both task dialogs use the same per-project directory and branch choices.
const taskProjectPickers = new Map();
const expandedTaskDescriptions = new Set();

function syncTaskDescription() {
  const description = $('#taskDescription');
  const button = $('[data-action="task-info-toggle"]');
  if (!description?.textContent || !button) return;
  const expanded = expandedTaskDescriptions.has(JSON.stringify([activeEnvironment, state.selectedRequirement]));
  description.classList.add('task-description-clamped');
  button.hidden = description.scrollHeight <= description.clientHeight + 1;
  description.classList.toggle('task-description-clamped', !expanded);
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? '收起' : '查看全部';
}

document.addEventListener('click', event => {
  if (!event.target.closest('[data-action="task-info-toggle"]')) return;
  const key = JSON.stringify([activeEnvironment, state.selectedRequirement]);
  if (expandedTaskDescriptions.has(key)) expandedTaskDescriptions.delete(key); else expandedTaskDescriptions.add(key);
  syncTaskDescription();
});
window.addEventListener('resize', syncTaskDescription);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncTaskDescription).observe($('#taskProjectsView'));

function resetTaskProjectPicker(selector) {
  taskProjectPickers.set(selector, { choices: new Map(), overviews: new Map(), rows: [], search: '', markup: null });
  const search = document.querySelector(`[data-picker-search="${selector.slice(1)}"]`);
  if (search) search.value = '';
}

function filterTaskProjectPicker(selector) {
  const container = $(selector);
  const picker = taskProjectPickers.get(selector);
  if (!container || !picker) return;
  const query = picker.search.trim().toLocaleLowerCase();
  const rows = [...container.querySelectorAll('[data-picker-search-text]')];
  let visible = 0;
  for (const row of rows) {
    row.hidden = !row.dataset.pickerSearchText.toLocaleLowerCase().includes(query);
    if (!row.hidden) visible++;
  }
  const empty = container.querySelector('[data-picker-empty]');
  if (empty) empty.hidden = visible > 0;
  const count = document.querySelector(`[data-picker-count="${selector.slice(1)}"]`);
  if (count) {
    const selected = container.querySelectorAll('input[name="project_ids"]:checked').length;
    count.textContent = query ? `找到 ${visible} / ${rows.length} 个项目 · 已选 ${selected} 个` : `${rows.length} 个可选项目 · 已选 ${selected} 个`;
  }
}

// Search only changes visibility. Filtered-out projects still participate in
// selection, validation and submission, and typing never rebuilds its field.
document.addEventListener('input', event => {
  const target = event.target;
  if (!target.dataset.pickerSearch) return;
  const selector = '#' + target.dataset.pickerSearch;
  const picker = taskProjectPickers.get(selector);
  if (picker) { picker.search = target.value; filterTaskProjectPicker(selector); }
});
document.addEventListener('toggle', event => {
  const details = event.target;
  if (!details.matches?.('[data-picker-project]') || String(details.open) === details.dataset.pickerDefaultExpanded) return;
  const container = details.closest('#projectPicker, #requirementProjectPicker, #taskDirectoryPicker');
  const choice = container && taskProjectPickers.get('#' + container.id)?.choices.get(details.dataset.pickerProject);
  if (choice) { choice.expanded = details.open; details.dataset.pickerDefaultExpanded = String(details.open); }
}, true);
document.addEventListener('invalid', event => {
  const details = event.target.closest?.('[data-picker-project]');
  if (details) details.open = true;
}, true);

function taskCreatesWorktree(mode) { return mode === 'new' || mode === 'existing'; }

function taskPickerSelection(selector) {
  const picker = taskProjectPickers.get(selector);
  return [...$(selector).querySelectorAll('input[name="project_ids"]:checked')].map(input => {
    const choice = picker?.choices.get(input.value) || { mode: 'project' };
    return { project_id: input.value, mode: choice.mode, ...(choice.mode === 'new' ? { branch: choice.branch, source: choice.source } : choice.mode === 'existing' ? { branch: choice.existingBranch || '' } : choice.mode === 'worktree' ? { path: choice.path } : {}) };
  });
}

function renderTaskProjectPicker(selector, projects, selected, environment, defaultBranch) {
  if (!taskProjectPickers.has(selector)) resetTaskProjectPicker(selector);
  const picker = taskProjectPickers.get(selector);
  const rows = projects.map(p => {
    let choice = picker.choices.get(p.id);
    if (!choice) { choice = { mode: 'new', path: '', source: '', branch: defaultBranch, branchEdited: false }; picker.choices.set(p.id, choice); }
    if (!choice.branchEdited) choice.branch = defaultBranch;
    const v = picker.overviews.get(p.id);
    const trees = (v?.project.worktrees || p.worktrees || []).filter(t => !t.bare && !t.missing && !t.prunable && !t.error && t.path !== p.path);
    if (choice.mode === 'new' && v && !choice.source) choice.source = defaultBranchSource(v);
    return { project: p, checked: selected.has(p.id), choice, overview: v, trees, prefix: `${selector.slice(1)}-${p.id}` };
  });
  picker.rows = rows;
  const container = $(selector);
  const markup = window.WorkHubUI.projectPicker(rows);
  // Polling often changes only Git status timestamps. Preserve the mounted
  // controls and searchable-select roots when their rendered choices agree.
  if (picker.markup !== markup) {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusID = focused?.id;
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroll = container.closest('.task-dialog-scroll');
    const scrollTop = scroll?.scrollTop;
    container.innerHTML = markup;
    picker.markup = markup;
    filterTaskProjectPicker(selector);
    if (focusID) {
      const next = document.getElementById(focusID);
      if (next && container.contains(next)) {
        next.focus({ preventScroll: true });
        if (selection?.[0] != null && typeof next.setSelectionRange === 'function') next.setSelectionRange(...selection);
      }
    }
    if (scroll) scroll.scrollTop = scrollTop;
  }
  filterTaskProjectPicker(selector);
  for (const p of projects) {
    const choice = picker.choices.get(p.id);
    if (selected.has(p.id) && choice.mode !== 'project' && !picker.overviews.has(p.id) && !choice.loading && !choice.error) {
      choice.loading = true;
      api(`/api/projects/${encodeURIComponent(p.id)}/git`, { environment }).then(v => {
        if (taskProjectPickers.get(selector) !== picker) return;
        picker.overviews.set(p.id, v);
      }).catch(error => { if (taskProjectPickers.get(selector) === picker) choice.error = error.message; }).finally(() => {
        choice.loading = false;
        if (taskProjectPickers.get(selector) === picker) refreshTaskProjectPicker(selector);
      });
    }
  }
}

function refreshTaskProjectPicker(selector) {
  if (selector === '#projectPicker' && $('#requirementDialog').open) renderRequirementProjectOptions();
  if (selector === '#requirementProjectPicker' && $('#requirementProjectsDialog').open) refreshRequirementProjectPicker();
  if (selector === '#taskDirectoryPicker' && $('#taskDirectoryDialog').open) refreshTaskDirectoryPicker();
}

function taskProjectPickerInput(selector, event) {
  const target = event.target;
  const row = target.closest('[data-project-id]');
  if (row && target.dataset.choice) {
    const choice = taskProjectPickers.get(selector).choices.get(row.dataset.projectId);
    if (target.type === 'radio' && !target.checked) return;
    choice[target.dataset.choice] = target.value;
    if (target.dataset.choice === 'branch') choice.branchEdited = true;
    if (target.dataset.choice === 'mode') choice.expanded = true;
    const data = taskProjectPickers.get(selector).rows.find(item => item.project.id === row.dataset.projectId);
    const summary = row.querySelector('[data-choice-summary]');
    if (summary && data) summary.textContent = window.WorkHubUI.projectChoiceSummary(data);
  }
  // Keep text inputs in place while typing; changing mode rebuilds its controls.
  if (event.type === 'change' && (target.dataset.choice === 'mode' || target.name === 'project_ids')) refreshTaskProjectPicker(selector);
}

function taskProjectPickerReady(selector) {
  const picker = taskProjectPickers.get(selector);
  return taskPickerSelection(selector).every(m => {
    const row = picker?.rows.find(item => item.project.id === m.project_id);
    return !!row && window.WorkHubUI.projectChoiceReady(row);
  });
}

function taskBranchSummary(q) { return window.WorkHubUI.branchSummary(q); }

function taskMemberExpectedBranch(m, q) { return window.WorkHubUI.expectedBranch(m, q); }
function taskMemberReusesDirectory(m) { return window.WorkHubUI.reusesDirectory(m); }


const taskProjectFilters = new Map();
function renderRequirements() {
  if (!taskInventory.loaded) return '<div class="loading">正在读取全部环境的任务…</div>';
  if (!taskInventory.requirements.length) return empty('为下一项开发工作，创建一个任务', '选择项目及其工作目录，围绕同一个目标组织开发工作。', 'new-requirement', '创建第一个任务');
  const text = $('#search').value.trim().toLowerCase();
  const reqs = taskInventory.requirements.filter(q => window.WorkHubUI.taskMatches(q, $('#taskStatusFilter')?.value || 'all') && ($('#archiveFilter').checked || q.state !== 'archived') && `${q.name} ${q.description || ''} ${q.slug} ${q.branch} ${taskBranchSummary(q)} ${q.environment_name}`.toLowerCase().includes(text));
  if (!reqs.length) return empty('没有匹配的任务', '可以清除搜索与状态筛选，返回未归档任务列表。', 'clear-task-filters', '清除搜索与筛选');
  return window.WorkHubUI.tasks(reqs);
}

function canOpenMember(m) {
  return window.WorkHubUI.canOpenMember(m);
}

function requirementDetail(q) {
  return window.WorkHubUI.taskDetail(q, state.projects, environmentName(), preferredProjectOpenTool(), taskProjectFilters.get(JSON.stringify([activeEnvironment,q.id])) || 'all');
}

function openRequirement() {
  if (state.busy) return;
  resetTaskProjectPicker('#projectPicker');
  requirementDraftToken = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  requirementDraftSlug = 'task-' + requirementDraftToken;
  const form = $('#requirementForm'); form.reset(); $('#requirementError').hidden = true;
  $('#requirementEnvironment').innerHTML = environmentOptions();
  $('#requirementEnvironment').value = activeEnvironment;
  $('#requirementDialog').showModal();
  loadRequirementProjects();
}

function renderRequirementProjectOptions(selectID = null) {
  const projects = requirementEnvironmentData?.projects || [];
  const selected = new Set([...$('#projectPicker').querySelectorAll('input[name="project_ids"]:checked')].map(input => input.value));
  if (selectID) selected.add(selectID);
  renderTaskProjectPicker('#projectPicker', projects, selected, $('#requirementEnvironment').value, 'codex/' + requirementDraftSlug);
  updatePreview();
}

async function loadRequirementProjects(preserveSelection = false, selectID = null) {
  clearTimeout(requirementPickerTimer);
  const revision = ++requirementPickerRevision;
  const environment = $('#requirementEnvironment').value;
  $('#requirementSubmit').disabled = true;
  $('#requirementError').hidden = true;
  if (!preserveSelection) {
    requirementEnvironmentData = null;
    $('#projectPicker').textContent = '正在连接执行环境…';
    resetTaskProjectPicker('#projectPicker');
    $('#workspacePreview').textContent = '';
  }
  try {
    const data = await api('/api/state', { environment });
    if (revision !== requirementPickerRevision || !$('#requirementDialog').open) return;
    requirementEnvironmentData = { ...data, environment };
    renderRequirementProjectOptions(selectID);
    if (data.status_refreshing) requirementPickerTimer = setTimeout(() => loadRequirementProjects(true), 1000);
  } catch (error) {
    if (revision !== requirementPickerRevision || !$('#requirementDialog').open) return;
    requirementEnvironmentData = null;
    $('#projectPicker').textContent = '';
    $('#requirementError').textContent = error.message;
    $('#requirementError').hidden = false;
  }
}

function updatePreview() {
  const projects = requirementEnvironmentData?.projects || [];
  const members = taskPickerSelection('#projectPicker');
  const path = workspaceDisplayPath(requirementEnvironmentData?.root || '', requirementDraftSlug);
  $('#workspacePreview').textContent = members.length ? members.map(m => {
    const p = projects.find(p => p.id === m.project_id);
    if (!p) return '';
    return p.name + ' · ' + (taskCreatesWorktree(m.mode) ? workspaceDisplayPath(path, p.folder) + '（新建 · ' + (m.branch || '请选择分支') + '）' : m.mode === 'project' ? p.path + '（项目原目录）' : (m.path || '请选择已有 Worktree'));
  }).join('\n') : '选择参与项目后，确认各项目实际使用的目录。';
  $('#requirementSubmit').disabled = !requirementEnvironmentData || requirementEnvironmentData.environment !== $('#requirementEnvironment').value || !members.length || members.length > 30 || !taskProjectPickerReady('#projectPicker');
}

$('#requirementEnvironment').addEventListener('change', () => loadRequirementProjects());
$('#requirementDialog').addEventListener('close', () => { clearTimeout(requirementPickerTimer); requirementPickerRevision++; });
$('#registerNewTaskProject').addEventListener('click', () => {
  clearTimeout(requirementPickerTimer);
  openProject(id => loadRequirementProjects(true, id), $('#requirementEnvironment').value);
});

$('#projectPicker').addEventListener('input', event => taskProjectPickerInput('#projectPicker', event));
$('#projectPicker').addEventListener('change', event => taskProjectPickerInput('#projectPicker', event));
$('#projectPicker').addEventListener('click', event => {
  const id = event.target.dataset.choiceRetry;
  if (id) { delete taskProjectPickers.get('#projectPicker').choices.get(id).error; renderRequirementProjectOptions(); }
});
$('#requirementForm').addEventListener('input', event => {
  if (event.target.name === 'name') {
    const readable = event.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    requirementDraftSlug = readable ? readable + '-' + requirementDraftToken : 'task-' + requirementDraftToken;
    renderRequirementProjectOptions();
  }
  updatePreview();
});
$('#requirementForm').addEventListener('change', updatePreview);
$('#requirementForm').addEventListener('submit', async event => {
  if ($('#requirementSubmit').disabled) { event.preventDefault(); return; }
  event.preventDefault(); const data = new FormData(event.target);
  const projectIDs = [...$('#projectPicker').querySelectorAll('input[name="project_ids"]:checked')].map(i => i.value);
  const body = { name: data.get('name'), slug: requirementDraftSlug, description: data.get('description'), project_ids: projectIDs, members: taskPickerSelection('#projectPicker') };
  const environment = $('#requirementEnvironment').value;
  let created;
  await mutation('正在创建任务并准备工作目录', async () => {
    const q = await api('/api/requirements', { environment, method: 'POST', body: JSON.stringify(body) });
    created = q;
    if (environment === activeEnvironment) state.requirements = [q, ...state.requirements.filter(current => current.id !== q.id)];
    $('#search').value = ''; $('#requirementDialog').close();
    toast(q.state === 'ready' ? '任务已创建，全部项目已就绪' : '任务已保存，部分项目创建失败，可单独重试', q.state !== 'ready');
  }, $('#requirementError'));
  if (created) await selectEnvironment(environment, '/requirements/' + created.id);
});

function openTaskEdit(id) {
  const q = state.requirements.find(q => q.id === id);
  if (!q || state.busy) return;
  taskEditContext = {id, environment: activeEnvironment};
  $('#taskEditName').value = q.name;
  $('#taskEditDescription').value = q.description || '';
  $('#taskEditError').hidden = true;
  $('#taskEditDialog').showModal();
  $('#taskEditName').focus();
}
$('#taskEditForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !taskEditContext) return;
  const context = {...taskEditContext};
  const body = {name: $('#taskEditName').value, description: $('#taskEditDescription').value};
  await mutation('正在保存任务信息', async () => {
    const q = await api(`/api/requirements/${encodeURIComponent(context.id)}`, {environment: context.environment, method: 'PATCH', body: JSON.stringify(body)});
    $('#taskEditDialog').close(); toast(q.context_warning ? '任务信息已保存；' + q.context_warning : '任务信息已保存', !!q.context_warning);
  }, $('#taskEditError'));
});
function openTaskDirectory(id, project) {
  const q = state.requirements.find(q => q.id === id);
  const m = q?.members.find(m => m.project_id === project);
  if (!m || state.busy) return;
  const p = state.projects.find(p => p.id === project);
  if (!p) return;
  const suffix = crypto.randomUUID().replace(/-/g,'').slice(0,8);
  taskDirectoryContext = {id, project, environment: activeEnvironment, path: workspaceDisplayPath(q.path, p.folder.slice(0,48) + '-' + suffix)};
  resetTaskProjectPicker('#taskDirectoryPicker');
  taskProjectPickers.get('#taskDirectoryPicker').choices.set(project, {mode: taskCreatesWorktree(m.mode) ? 'worktree' : (m.mode || 'project'), path: m.path, source: '', branch: 'codex/' + q.slug + '-' + suffix, branchEdited: true});
  $('#taskDirectoryCurrent').textContent = p.name + ' · 当前使用 ' + m.path + ' · ' + (m.worktree?.branch || m.branch || 'detached HEAD');
  $('#taskDirectoryError').hidden = true;
  $('#taskDirectoryPicker').innerHTML = '';
  $('#taskDirectoryDialog').showModal();
  refreshTaskDirectoryPicker();
}
function refreshTaskDirectoryPicker() {
  const context = taskDirectoryContext;
  if (!context || !$('#taskDirectoryDialog').open || context.environment !== activeEnvironment) return;
  const q = state.requirements.find(q => q.id === context.id);
  const p = state.projects.find(p => p.id === context.project);
  if (!q || !p) return;
  renderTaskProjectPicker('#taskDirectoryPicker', [p], new Set([p.id]), context.environment, 'codex/' + q.slug);
  $('#taskDirectoryPicker input[name="project_ids"]').disabled = true;
  updateTaskDirectoryPreview();
}
function updateTaskDirectoryPreview() {
  if (!taskDirectoryContext) return;
  const selected = taskPickerSelection('#taskDirectoryPicker')[0];
  const p = state.projects.find(p => p.id === taskDirectoryContext.project);
  const choice = taskProjectPickers.get('#taskDirectoryPicker')?.choices.get(p?.id);
  $('#taskDirectoryPreview').textContent = !selected ? '' : taskCreatesWorktree(selected.mode) ? taskDirectoryContext.path + (selected.mode === 'existing' ? '\n使用已有分支 ' : '\n新建分支 ') + (selected.branch || '请选择分支') : selected.mode === 'project' ? p.path + '（项目原目录）' : selected.path || '请选择已有 Worktree';
  $('#taskDirectorySubmit').disabled = !selected || !taskProjectPickerReady('#taskDirectoryPicker') || !!choice?.error;
}
for (const type of ['input', 'change']) $('#taskDirectoryPicker').addEventListener(type, event => { taskProjectPickerInput('#taskDirectoryPicker', event); updateTaskDirectoryPreview(); });
$('#taskDirectoryPicker').addEventListener('click', event => {
  const id = event.target.dataset.choiceRetry;
  if (id) { delete taskProjectPickers.get('#taskDirectoryPicker').choices.get(id).error; refreshTaskDirectoryPicker(); }
});
$('#taskDirectoryForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || $('#taskDirectorySubmit').disabled || !taskDirectoryContext) return;
  const context = {...taskDirectoryContext};
  const selected = taskPickerSelection('#taskDirectoryPicker')[0];
  if (taskCreatesWorktree(selected.mode)) selected.path = context.path;
  await mutation('正在更换工作目录', async () => {
    const q = await api(`/api/requirements/${encodeURIComponent(context.id)}/projects/${encodeURIComponent(context.project)}`, {environment: context.environment, method:'PUT', body:JSON.stringify(selected)});
    $('#taskDirectoryDialog').close();
    toast(q.members.find(m => m.project_id === context.project)?.state === 'ready' ? '已更换工作目录，旧目录保留' : '目录配置已保存，请查看准备失败原因', q.state !== 'ready');
  }, $('#taskDirectoryError'));
});
async function removeTaskProject(id, project) {
  const q = state.requirements.find(q => q.id === id);
  const m = q?.members.find(m => m.project_id === project);
  if (!m || !confirm(`从“${q.name}”移除“${m.project_name}”？\n工作目录、分支、代码和已有会话均保留。`)) return;
  const environment = activeEnvironment;
  await mutation('正在解除项目关联', async () => {
    const updated = await api(`/api/requirements/${encodeURIComponent(id)}/projects/${encodeURIComponent(project)}`, {environment, method:'DELETE'});
    toast(updated.context_warning ? '已解除关联；' + updated.context_warning : '已移除项目关联，工作目录保留', !!updated.context_warning);
  });
}
