'use strict';
let requirementEnvironmentData = null;
let requirementPickerRevision = 0;
let requirementPickerTimer;
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
  taskProjectPickers.set(selector, { choices: new Map(), overviews: new Map() });
}

function taskPickerSelection(selector) {
  const picker = taskProjectPickers.get(selector);
  return [...$(selector).querySelectorAll('input[name="project_ids"]:checked')].map(input => {
    const choice = picker?.choices.get(input.value) || { mode: 'project' };
    return { project_id: input.value, mode: choice.mode, ...(choice.mode === 'new' ? { branch: choice.branch, source: choice.source } : choice.mode === 'worktree' ? { path: choice.path } : {}) };
  });
}

function renderTaskProjectPicker(selector, projects, selected, environment, defaultBranch) {
  if (!taskProjectPickers.has(selector)) resetTaskProjectPicker(selector);
  const picker = taskProjectPickers.get(selector);
  const rows = projects.map(p => {
    let choice = picker.choices.get(p.id);
    if (!choice) { choice = { mode: 'project', path: '', source: '', branch: defaultBranch, branchEdited: false }; picker.choices.set(p.id, choice); }
    if (!choice.branchEdited) choice.branch = defaultBranch;
    const v = picker.overviews.get(p.id);
    const trees = (v?.project.worktrees || p.worktrees || []).filter(t => !t.bare && !t.missing && !t.prunable && !t.error && t.path !== p.path);
    if (choice.mode === 'new' && v && !choice.source) choice.source = defaultBranchSource(v);
    return { project: p, checked: selected.has(p.id), choice, overview: v, trees, prefix: `${selector.slice(1)}-${p.id}` };
  });
  $(selector).innerHTML = window.WorkHubUI.projectPicker(rows);
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
}

function taskProjectPickerInput(selector, event) {
  const target = event.target;
  const row = target.closest('[data-project-id]');
  if (row && target.dataset.choice) {
    const choice = taskProjectPickers.get(selector).choices.get(row.dataset.projectId);
    choice[target.dataset.choice] = target.value;
    if (target.dataset.choice === 'branch') choice.branchEdited = true;
  }
  // Keep text inputs in place while typing; changing mode rebuilds its controls.
  if (event.type === 'change' && (target.dataset.choice === 'mode' || target.name === 'project_ids')) refreshTaskProjectPicker(selector);
}

function taskProjectPickerReady(selector) {
  return taskPickerSelection(selector).every(m => m.mode === 'project' || (m.mode === 'worktree' ? !!m.path : !!m.branch && !!m.source));
}

function taskBranchSummary(q) { return window.WorkHubUI.branchSummary(q); }

function taskMemberExpectedBranch(m, q) { return window.WorkHubUI.expectedBranch(m, q); }
function taskMemberReusesDirectory(m) { return window.WorkHubUI.reusesDirectory(m); }


function renderRequirements() {
  if (!taskInventory.loaded) return '<div class="loading">正在读取全部环境的任务…</div>';
  if (!taskInventory.requirements.length) return empty('为下一项开发工作，创建一个任务', '选择执行环境，再选择该环境的主项目与参与项目，使用已有目录或新建工作目录。', 'new-requirement', '创建第一个任务');
  const text = $('#search').value.trim().toLowerCase();
  const reqs = taskInventory.requirements.filter(q => ($('#archiveFilter').checked || q.state !== 'archived') && `${q.name} ${q.slug} ${q.branch} ${taskBranchSummary(q)} ${q.environment_name}`.toLowerCase().includes(text));
  if (!reqs.length) return empty('没有匹配的任务', '尝试其他关键词，或勾选“显示归档”。');
  return window.WorkHubUI.tasks(reqs);
}

function canOpenMember(m) {
  return window.WorkHubUI.canOpenMember(m);
}

function requirementDetail(q) {
  return window.WorkHubUI.taskDetail(q, state.projects, environmentName(), preferredProjectOpenTool());
}

function openRequirement() {
  if (state.busy) return;
  resetTaskProjectPicker('#projectPicker');
  const form = $('#requirementForm'); form.reset(); $('#requirementError').hidden = true;
  $('#requirementEnvironment').innerHTML = environmentOptions();
  $('#requirementEnvironment').value = activeEnvironment;
  $('#requirementDialog').showModal();
  loadRequirementProjects();
}

function renderRequirementProjectOptions(selectID = null) {
  const projects = requirementEnvironmentData?.projects || [];
  const selected = new Set([...$('#projectPicker').querySelectorAll('input:checked')].map(input => input.value));
  if (selectID) selected.add(selectID);
  const primary = $('#primaryProject').value;
  $('#primaryProject').innerHTML = '<option value="">请选择主项目</option>' + projects.map(p => `<option value="${esc(p.id)}" ${p.error ? 'disabled' : ''}>${esc(p.name)}${p.error ? '（不可用）' : ''}</option>`).join('');
  if (projects.some(p => p.id === primary && !p.error)) $('#primaryProject').value = primary;
  if (primary) selected.add(primary);
  renderTaskProjectPicker('#projectPicker', projects, selected, $('#requirementEnvironment').value, 'codex/' + $('#requirementForm').elements.slug.value);
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
    $('#primaryProject').value = '';
    $('#primaryProject').innerHTML = '<option value="">正在读取项目…</option>';
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
    $('#primaryProject').innerHTML = '<option value="">无法读取项目</option>';
    $('#projectPicker').textContent = '';
    $('#requirementError').textContent = error.message;
    $('#requirementError').hidden = false;
  }
}

function updatePreview() {
  const form = $('#requirementForm');
  const projects = requirementEnvironmentData?.projects || [];
  const primary = form.elements.primary_project_id.value;
  $('#projectPicker').querySelectorAll('input[name="project_ids"]').forEach(input => {
    const project = projects.find(p => p.id === input.value);
    if (input.value === primary) input.checked = true;
    input.disabled = input.value === primary || !!project?.error;
  });
  const selected = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => projects.find(p => p.id === i.value)).filter(Boolean);
  const path = workspaceDisplayPath(requirementEnvironmentData?.root || '', form.elements.slug.value || '<目录标识>');
  const members = taskPickerSelection('#projectPicker');
  $('#workspacePreview').textContent = path + '/  ← 任务说明\n' + members.map(m => {
    const p = projects.find(p => p.id === m.project_id);
    return (m.mode === 'new' ? workspaceDisplayPath(path, p.folder) + '（新建）' : m.mode === 'project' ? p.path + '（项目原目录）' : (m.path || '请选择已有 Worktree')) + (p.id === primary ? '  ← 主项目' : '');
  }).join('\n');
  $('#requirementSubmit').disabled = !requirementEnvironmentData || requirementEnvironmentData.environment !== $('#requirementEnvironment').value || !projects.some(p => p.id === primary && !p.error) || selected.length > 30 || !taskProjectPickerReady('#projectPicker');
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
$('#primaryProject').addEventListener('change', () => renderRequirementProjectOptions());
$('#requirementForm').addEventListener('input', event => {
  const form = event.currentTarget;
  if (event.target.name === 'name' && !form.elements.slug.dataset.edited) {
    form.elements.slug.value = form.elements.name.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  if (event.target.name === 'slug') form.elements.slug.dataset.edited = '1';
  if (event.target.name === 'name' || event.target.name === 'slug') renderRequirementProjectOptions();
  updatePreview();
});
$('#requirementForm').addEventListener('reset', event => { delete event.target.elements.slug.dataset.edited; });
$('#requirementForm').addEventListener('change', updatePreview);
$('#requirementForm').addEventListener('submit', async event => {
  if ($('#requirementSubmit').disabled) { event.preventDefault(); return; }
  event.preventDefault(); const data = new FormData(event.target);
  const primary = data.get('primary_project_id');
  const projectIDs = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => i.value);
  const body = { name: data.get('name'), slug: data.get('slug'), description: data.get('description'), primary_project_id: primary, project_ids: projectIDs, members: taskPickerSelection('#projectPicker') };
  const environment = $('#requirementEnvironment').value;
  let created;
  await mutation('正在创建任务并准备工作目录', async () => {
    const q = await api('/api/requirements', { environment, method: 'POST', body: JSON.stringify(body) });
    created = q; $('#search').value = ''; $('#requirementDialog').close();
    toast(q.state === 'ready' ? '任务已创建，全部项目已就绪' : '任务已保存，部分项目创建失败，可单独重试', q.state !== 'ready');
  }, $('#requirementError'));
  if (created) await selectEnvironment(environment, '/requirements/' + created.id);
});
