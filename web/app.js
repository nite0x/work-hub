'use strict';
const $ = (q, root = document) => root.querySelector(q);
const token = $('meta[name="csrf-token"]').content;
const sessionReadOnly = $('meta[name="session-mode"]')?.content === 'read-only';
let activeEnvironment = new URLSearchParams(location.search).get('environment') || 'local';
const state = { view: 'requirements', projects: [], requirements: [], selectedProject: null, selectedRequirement: null, root: '', terminal: {}, busy: false, refreshing: false, loaded: false };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { ready: '已就绪', partial: '部分就绪', archived: '已归档', creating: '创建中', pending: '待创建', failed: '创建失败' };
const badge = (kind, text) => `<span class="badge ${esc(kind)}">${esc(text || labels[kind] || kind)}</span>`;
const branch = value => `<span class="branch">⑂ ${esc(value || 'detached HEAD')}</span>`;
const allTrees = () => state.projects.flatMap(p => p.worktrees);
let toastTimer;
let refreshTimer;
let projectAddedCallback = null;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4500);
}
async function api(path, options = {}) {
  const environment = activeEnvironment;
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Environment-ID': environment, ...options.headers } });
  if (environment !== activeEnvironment) throw new DOMException('执行环境已切换', 'AbortError');
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的响应，请查看服务日志。'); }
  if (environment !== activeEnvironment) throw new DOMException('执行环境已切换', 'AbortError');
  if (!response.ok) {
    const error = new Error([data.error, ...(data.details || [])].filter(Boolean).join('\n'));
    error.command = data.command;
    error.code = data.code;
    throw error;
  }
  return data;
}
async function refresh(force = false) {
  if (state.refreshing || state.busy) return;
  clearTimeout(refreshTimer);
  let nextRefresh = 10000;
  state.refreshing = true;
  $('#refreshButton').disabled = true;
  try {
    const data = await api('/api/state' + (force ? '?refresh=1' : ''));
    const changed = !state.loaded || renderStateKey(state) !== renderStateKey(data);
    Object.assign(state, data, { loaded: true });
    $('#offlineBanner').hidden = true;
    nextRefresh = data.status_refreshing ? 1000 : 10000;
    $('#syncText').textContent = data.status_refreshing ? '状态更新中 · 显示最近结果' : data.refreshed_at ? '已同步 · ' + new Date(data.refreshed_at).toLocaleTimeString('zh-CN', { hour12: false }) : '已读取任务';
    $('#syncDot').classList.remove('offline');
    if (changed) { render(); refreshRequirementProjectPicker(); }
    else {
      updateCheckTimes();
      if (state.view === 'requirements' && state.selectedRequirement) refreshRequirementSessions(state.selectedRequirement, false);
    }
  } catch (error) {
    $('#offlineBanner').textContent = '状态刷新失败：' + error.message;
    $('#offlineBanner').hidden = false;
    $('#syncText').textContent = '连接中断';
    if (!state.loaded) $('#content').innerHTML = '<div class="empty"><h2>暂时无法连接执行环境</h2><p>请检查本机服务；WSL 环境可在设置页重新连接恢复。</p><a class="button secondary" href="#/settings">打开设置</a></div>';
  } finally {
    state.refreshing = false; $('#refreshButton').disabled = false;
    refreshTimer = setTimeout(() => { if (!document.hidden) refresh(); }, nextRefresh);
  }
}
function renderStateKey(data) {
  // Once a result exists, polling metadata must not rebuild the workspace.
  // The first completed check still changes the key and enables its actions.
  return JSON.stringify([data.projects, data.requirements, data.terminal, data.master_sync, data.root], function (key, value) {
    if (key === 'refreshing' && this.status_updated_at) return undefined;
    if (key === 'status_updated_at') return Boolean(value);
    return value;
  });
}
function updateCheckTimes() {
  const trees = new Map(allTrees().map(t => [t.path, t]));
  document.querySelectorAll('#content time[data-status-path]').forEach(time => {
    const updatedAt = trees.get(time.dataset.statusPath)?.status_updated_at;
    if (!updatedAt) return;
    const checked = new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
    if (time.textContent !== checked) time.textContent = checked;
    if (time.getAttribute('datetime') !== updatedAt) time.setAttribute('datetime', updatedAt);
  });
}
function stat(label, value, caption, symbol) {
  return `<div class="stat" title="${esc(caption)}"><div class="stat-label"><span class="stat-symbol" aria-hidden="true">${symbol}</span>${esc(label)}</div><div class="stat-value">${value}</div></div>`;
}
function readRoute() {
  const route = location.hash.slice(1);
  state.view = route === '/settings' ? 'settings' : route === '/projects' ? 'projects' : 'requirements';
  const match = route.match(/^\/requirements\/([a-zA-Z0-9_-]+)$/);
  state.selectedRequirement = match ? match[1] : null;
}
function navigate(route) {
  if (location.hash === '#' + route) { readRoute(); render(); }
  else location.hash = route;
}
window.addEventListener('hashchange', () => {
  readRoute(); $('#search').value = '';
  render(); window.scrollTo(0, 0); $('#pageTitle').focus({ preventScroll: true });
});
function render() {
  const settingsView = state.view === 'settings';
  const reqView = state.view === 'requirements';
  const detailView = reqView && !!state.selectedRequirement;
  const requirement = detailView ? state.requirements.find(q => q.id === state.selectedRequirement) : null;
  document.title = settingsView ? '设置 · Work Hub' : requirement ? requirement.name + ' · Work Hub' : 'Work Hub';
  $('#backToRequirements').hidden = !detailView;
  $('#stats').hidden = detailView || settingsView;
  $('#panelToolbar').hidden = detailView;
  $('#newButton').hidden = detailView || settingsView;
  $('#settingsPage').hidden = !settingsView;
  $('#workContent').hidden = settingsView;
  $('#reqCount').textContent = state.requirements.filter(q => q.state !== 'archived').length;
  $('#projectCount').textContent = state.projects.length;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#breadcrumbTitle').textContent = settingsView ? '设置' : detailView ? '任务 / ' + (requirement?.name || '任务不存在') : reqView ? '任务' : '项目与 Worktree';
  $('#eyebrow').textContent = settingsView ? 'SETTINGS' : detailView ? 'TASK' : reqView ? 'TASKS' : 'PROJECTS';
  $('#pageTitle').textContent = settingsView ? '设置' : detailView ? requirement?.name || '任务不存在' : reqView ? '任务' : '项目与 Worktree';
  $('#pageSubtitle').textContent = settingsView ? '管理执行环境、终端工具与每日更新。' : detailView ? '查看关联项目和 Codex 会话，继续当前任务中的开发。' : reqView ? '围绕一项开发目标，集中管理相关项目的工作目录、分支和会话。' : '登记项目，掌握它的全部工作目录、分支与任务归属。';
  $('#newButton').innerHTML = `<span>＋</span> ${reqView ? '创建任务' : '添加项目'}`;
  $('#panelTitle').textContent = reqView ? '全部任务' : '已登记项目';
  $('#search').placeholder = reqView ? '搜索任务名称、分支…' : '搜索项目名称、目录…';
  $('#archiveFilterWrap').hidden = !reqView;
  renderSettings();
  $('#rootPath').textContent = 'WORKSPACE ROOT  ' + state.root;
  if (settingsView) return;
  const trees = allTrees();
  $('#stats').innerHTML = reqView
    ? stat('进行中的任务', state.requirements.filter(q => q.state !== 'archived').length, '集中管理跨项目工作', '▤') + stat('已就绪任务', state.requirements.filter(q => q.state === 'ready').length, '所有项目已准备完成', '✓') + stat('关联项目', state.projects.length, '复用已登记的 Git 仓库', '◇') + stat('任务工作目录', trees.filter(t => t.requirement_id).length, '与本地 Git 状态保持同步', '⑂')
    : stat('已登记项目', state.projects.length, '本地独立 Git 仓库', '◇') + stat('全部 Worktree', trees.length, '含主目录及其他工具创建的目录', '⑂') + stat('有修改的目录', trees.filter(t => t.dirty > 0).length, '当前未提交的代码现场', '◌') + stat('未关联任务', trees.filter(t => !t.requirement_id).length, '主目录或其他工作目录', '↳');
  $('#content').innerHTML = detailView
    ? requirement ? requirementDetail(requirement) : empty('这个任务不存在', '可返回任务列表，重新选择一个任务。')
    : reqView ? renderRequirements() : renderProjects();
  if (requirement) refreshRequirementSessions(requirement.id, false);
}
function empty(title, description, action, button) {
  return `<div class="empty"><div class="empty-icon">${action === 'new-project' ? '◇' : '⑂'}</div><h2>${esc(title)}</h2><p>${esc(description)}</p>${action ? `<button class="button primary" data-action="${action}">＋ ${esc(button)}</button>` : ''}</div>`;
}
function renderRequirements() {
  if (!state.projects.length) return empty('先连接你的第一个项目', '添加项目后，就可以围绕一项开发目标，选择相关项目创建任务。', 'new-project', '添加项目');
  if (!state.requirements.length) return empty('为下一项开发工作，创建一个任务', '选好主项目和参与项目，从本地 master 创建各项目的分支与独立工作目录。', 'new-requirement', '创建第一个任务');
  const text = $('#search').value.trim().toLowerCase();
  const reqs = state.requirements.filter(q => ($('#archiveFilter').checked || q.state !== 'archived') && `${q.name} ${q.slug} ${q.branch}`.toLowerCase().includes(text));
  if (!reqs.length) return empty('没有匹配的任务', '尝试其他关键词，或勾选“显示归档”。');
  return reqs.map(q => {
    const primary = q.members.find(m => m.project_id === q.primary_project_id);
    return `<a class="list-row" href="#/requirements/${esc(q.id)}" aria-label="打开任务 ${esc(q.name)}"><span class="row-icon">▤</span><div class="row-main"><div class="row-title">${esc(q.name)} ${badge(q.state)}</div><div class="row-subtitle"><span>${q.members.length} 个项目 · 主项目 ${esc(primary?.project_name)}</span><code>⑂ ${esc(q.branch)}</code></div></div><div class="row-meta"><span>${q.members.filter(m => m.worktree?.dirty > 0).length} 个项目有修改</span><span class="row-time">${new Date(q.created_at).toLocaleDateString('zh-CN')}</span></div><span class="chevron">›</span></a>`;
  }).join('');
}
function treeState(t, pending = false) {
  if (!t) return badge(pending ? 'neutral' : 'failed', pending ? '正在发现目录' : '目录未发现');
  if (t.missing) return badge('failed', '目录丢失');
  if (t.error) return badge('failed', '读取失败');
  if (t.prunable) return badge('warning', '待修复登记');
  if (!t.status_updated_at) return badge('neutral', '正在检查');
  const checked = new Date(t.status_updated_at).toLocaleTimeString('zh-CN', { hour12: false });
  return (t.dirty ? badge('warning', `${t.dirty} 项修改`) : badge('ready', '干净')) + `<div class="comparison status-checked-at">上次检查 <time data-status-path="${esc(t.path)}" datetime="${esc(t.status_updated_at)}">${esc(checked)}</time></div>`;
}
function canOpenMember(m) {
  const t = m.worktree;
  return m.state === 'ready' && t?.status_updated_at && !t.bare && !t.missing && !t.prunable && !t.error;
}
function requirementDetail(q) {
  const ready = q.state === 'ready' && q.members.every(m => canOpenMember(m) && !m.worktree.detached && m.worktree.branch === q.branch);
  const pending = m => !m.worktree?.status_updated_at && state.projects.find(p => p.id === m.project_id)?.refreshing;
  const workspaceBadge = q.state === 'ready' && !ready ? q.members.some(pending) ? badge('neutral', '状态检查中') : badge('warning', '工作区需检查') : badge(q.state);
  const primary = q.members.find(m => m.project_id === q.primary_project_id);
  const rows = [...q.members].sort((a, b) => Number(b.project_id === q.primary_project_id) - Number(a.project_id === q.primary_project_id)).map(m => {
    const t = m.worktree;
    const usable = canOpenMember(m);
    return `<tr><td><strong>${esc(m.project_name)} ${m.project_id === q.primary_project_id ? badge('primary-tag', '主项目') : ''}</strong><div class="path">${esc(m.path)}</div></td><td>${t ? branch(t.branch) : '<span class="quiet">尚未读取</span>'}${t && t.branch !== q.branch ? `<div class="table-message">分支已变化，预期 ${esc(q.branch)}</div>` : ''}${t?.compare_available ? `<div class="comparison">相对 master：↑ ${t.ahead} ↓ ${t.behind}</div>` : ''}</td><td><span class="branch">master</span><div class="comparison">${esc(m.base_commit.slice(0, 8))}</div></td><td>${m.state === 'ready' ? treeState(t, pending(m)) : badge(m.state)}${m.error ? `<div class="table-message">${esc(m.error)}</div>` : ''}${t?.error ? `<div class="table-message">${esc(t.error)}</div>` : ''}</td><td><div class="workspace-project-actions"><button type="button" class="button small secondary" data-action="workspace-terminal" data-id="${esc(m.project_id)}" data-path="${esc(m.path)}" aria-label="打开 ${esc(m.project_name)} 的终端" ${usable ? '' : 'disabled'}>打开终端 ↗</button><button type="button" class="button small subtle" data-action="git-open" data-id="${esc(m.project_id)}" data-path="${esc(m.path)}" aria-label="打开 ${esc(m.project_name)} 的 Git 操作" ${usable ? '' : 'disabled'}>Git 操作</button></div>${!usable ? '<div class="table-message">' + (pending(m) ? '正在检查工作目录…' : '工作目录不可用') + '</div>' : ''}</td></tr>`;
  }).join('');
  return `<div class="detail requirement-workspace"><div class="detail-top"><div><h2>关联项目 ${workspaceBadge}</h2><div class="detail-path">${esc(q.path)}</div></div><div class="detail-actions"><button type="button" class="button small secondary" data-action="add-requirement-projects" data-id="${esc(q.id)}" ${q.state === 'archived' || q.state === 'creating' || q.members.length >= 30 ? 'disabled' : ''}>＋ 添加项目</button>${q.state === 'partial' ? `<button class="button small subtle" data-action="retry" data-id="${esc(q.id)}">↻ 重试失败项</button>` : ''}<button class="button small secondary" data-action="command" data-id="${esc(q.id)}" ${ready ? '' : 'disabled'}>复制启动命令</button><button class="button small primary" data-action="launch" data-id="${esc(q.id)}" ${ready ? '' : 'disabled'}>↗ 打开终端 · Codex</button><button class="button small secondary" data-action="archive" data-id="${esc(q.id)}">${q.state === 'archived' ? '取消归档' : '归档'}</button></div></div>${q.description ? `<p class="description">${esc(q.description)}</p>` : ''}<div class="detail-summary"><span>关联项目 <b>${q.members.length} 个</b></span><span>主目录 <b>${esc(primary?.project_name)}</b></span><span>所有项目从 <b>本地 master</b> 创建</span></div><div class="table-scroll"><table><thead><tr><th>项目 / 工作目录</th><th>实际分支</th><th>创建基线</th><th>状态</th><th>进入工作目录</th></tr></thead><tbody>${rows}</tbody></table></div><div class="banner note">各项目的终端和 Git 操作直接进入上表对应的工作目录。${esc(state.terminal.message || '')}</div>${renderRequirementSessions(q)}</div>`;
}
function renderProjects() {
  if (!state.projects.length) return empty('你的项目，从这里连接', '输入已有 Git 仓库的主目录。已有 worktree 会自动发现，后续每 10 秒刷新本地状态。', 'new-project', '添加第一个项目');
  const text = $('#search').value.trim().toLowerCase();
  const projects = state.projects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(text));
  if (!projects.length) return empty('没有匹配的项目', '试试其他项目名称或路径。');
  let html = `<div class="project-list">${projects.map(p => `<button class="project-card ${p.id === state.selectedProject ? 'selected' : ''}" data-action="select-project" data-id="${esc(p.id)}"><div class="project-card-top"><strong>${esc(p.name)}</strong><span class="project-dot ${p.error || (p.status_updated_at && !p.has_master) ? 'invalid' : ''}"></span></div><span class="path">${esc(p.path)}</span><div class="project-card-bottom"><span>${p.worktrees.length} 个 worktree</span><span>·</span><span>${p.worktrees.filter(t => t.dirty).length} 个有修改</span>${!p.status_updated_at && p.refreshing ? badge('neutral', '正在检查') : !p.has_master ? badge('warning', '无本地 master') : ''}</div></button>`).join('')}</div>`;
  const selected = projects.find(p => p.id === state.selectedProject);
  if (!selected) return html;
  const p = selected;
  const rows = p.worktrees.map(t => `<tr><td><strong>${esc(t.path.split('/').pop())} ${t.path === p.path ? badge('primary-tag', '登记目录') : ''}${t.locked ? badge('neutral', '已锁定') : ''}${t.detached ? badge('warning', 'Detached') : ''}</strong><div class="path">${esc(t.path)}</div></td><td>${branch(t.branch)}${t.compare_available ? `<div class="comparison">相对 master：↑ ${t.ahead} ↓ ${t.behind}</div>` : ''}</td><td>${t.requirement_id ? `<button class="button small subtle" data-action="jump-requirement" data-id="${esc(t.requirement_id)}">${esc(t.requirement_name)} ↗</button>` : '<span class="quiet">未关联任务</span>'}</td><td>${treeState(t)}${t.error ? `<div class="table-message">${esc(t.error)}</div>` : ''}</td><td><button class="button small secondary" data-action="copy-path" data-path="${esc(t.path)}">复制路径</button></td></tr>`).join('');
  html += `<div class="detail"><div class="detail-top"><div><div class="eyebrow">PROJECT DETAIL</div><h2>${esc(p.name)}</h2><div class="detail-path">${esc(p.path)}</div></div><div class="detail-actions"><button type="button" class="button small primary" data-action="new-worktree" data-id="${esc(p.id)}" ${p.error ? 'disabled' : ''}>＋ 创建 Worktree</button><button type="button" class="button small secondary" data-action="git-open" data-id="${esc(p.id)}">Git 操作 · 分支管理</button><button class="button small secondary" data-action="remove-project" data-id="${esc(p.id)}">移除登记</button></div></div><div class="detail-summary"><span>自动发现 <b>${p.worktrees.length} 个 worktree</b></span><span>更新间隔 <b>10 秒</b></span><span>任务基线 <b>master</b></span></div>${p.error ? `<div class="banner error">${esc(p.error)}</div>` : `<div class="table-scroll"><table><thead><tr><th>工作目录</th><th>分支 / 相对 master</th><th>关联任务</th><th>修改状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}${p.status_updated_at && !p.has_master ? `<div class="banner note">该仓库缺少本地 master。先在 Git 操作中获取远端分支，再选择正确来源创建本地 master。<button type="button" class="button small primary" data-action="git-open" data-id="${esc(p.id)}">准备 master 分支</button></div>` : ''}</div>`;
  return html;
}
function openProject(onAdded = null) {
  if (state.busy) return;
  projectAddedCallback = onAdded;
  $('#projectForm').reset(); $('#projectError').hidden = true; $('#projectDialog').showModal();
}
function openRequirement() {
  if (state.busy) return;
  if (!state.projects.length) { openProject(); return; }
  const form = $('#requirementForm'); form.reset(); $('#requirementError').hidden = true;
  $('#primaryProject').innerHTML = '<option value="">请选择主项目</option>' + state.projects.map(p => `<option value="${esc(p.id)}" ${!p.has_master || p.error ? 'disabled' : ''}>${esc(p.name)}${!p.status_updated_at ? '（正在检查）' : !p.has_master ? '（缺少 master）' : ''}${p.error ? '（不可用）' : ''}</option>`).join('');
  $('#projectPicker').innerHTML = state.projects.map(p => `<label class="project-option"><input type="checkbox" name="project_ids" value="${esc(p.id)}" ${!p.has_master || p.error ? 'disabled' : ''}><span>${esc(p.name)}<small>${esc(p.path)}</small></span>${!p.status_updated_at ? badge('neutral', '正在检查') : !p.has_master ? badge('warning', '缺少 master') : badge('neutral', 'master')}</label>`).join('');
  const missingMaster = state.projects.filter(p => p.status_updated_at && !p.has_master && !p.error);
  $('#masterPreparation').hidden = !missingMaster.length;
  $('#masterPreparation').innerHTML = missingMaster.length ? `${missingMaster.length} 个项目缺少本地 master，创建前可先获取远端并准备分支。<button type="button" class="button small secondary" data-action="git-prepare-project" data-id="${esc(missingMaster[0].id)}">前往准备 ${esc(missingMaster[0].name)}</button>` : '';
  updatePreview(); $('#requirementDialog').showModal();
}
function updatePreview() {
  const form = $('#requirementForm');
  const primary = form.elements.primary_project_id.value;
  $('#projectPicker').querySelectorAll('input').forEach(input => {
    const project = state.projects.find(p => p.id === input.value);
    if (input.value === primary) input.checked = true;
    input.disabled = input.value === primary || !project.has_master || !!project.error;
  });
  const selected = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => state.projects.find(p => p.id === i.value));
  const path = workspaceDisplayPath(state.root, form.elements.slug.value || '<目录标识>');
  $('#workspacePreview').textContent = path + '/\n' + selected.map((p, i) => `${i === selected.length - 1 ? '└─' : '├─'} ${p.folder}/${p.id === primary ? '  ← 主项目' : ''}`).join('\n');
}
function workspaceDisplayPath(root, ...parts) {
  const separator = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + separator + parts.join(separator);
}
async function mutation(title, fn, errorElement) {
  if (state.busy) return;
  state.busy = true; document.body.classList.add('busy'); $('#busyTitle').textContent = title; $('#busyPanel').hidden = false;
  if (errorElement) errorElement.hidden = true;
  try { await fn(); }
  catch (error) {
    if (errorElement) { errorElement.textContent = error.message; errorElement.hidden = false; } else toast(error.message, true);
    if (error.command) showCommand(error.command);
  } finally { state.busy = false; document.body.classList.remove('busy'); $('#busyPanel').hidden = true; await refresh(); }
}
function showCommand(command) {
  $('#commandTitle').textContent = '终端命令';
  $('#commandDialog .eyebrow').textContent = 'TERMINAL COMMAND';
  $('#commandDialog .dialog-description').textContent = '在当前执行环境的终端执行以下命令；Windows 本机使用 PowerShell。';
  $('#commandText').value = command; if (!$('#commandDialog').open) $('#commandDialog').showModal();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { showCommand(text); toast('请在弹窗中选择并复制内容'); }
}
async function handleAction(action, target) {
  if (state.busy) return;
  const id = target.dataset.id;
  if (action === 'new-project') return openProject();
  if (action === 'new-worktree') return openWorktree(id);
  if (action === 'new-requirement') return openRequirement();
  if (action === 'add-requirement-projects') return openRequirementProjects(id);
  if (action === 'select-project') { state.selectedProject = id === state.selectedProject ? null : id; render(); return; }
  if (action === 'jump-requirement') { navigate('/requirements/' + id); return; }
  if (action === 'workspace-terminal') return mutation('正在打开项目终端', async () => {
    const result = await api(`/api/projects/${id}/git`, { method: 'POST', body: JSON.stringify({ action: 'terminal', path: target.dataset.path }) });
    toast(result.message);
  });
  if (action === 'copy-path') return copy(target.dataset.path);
  if (action === 'command') {
    try { const plan = await api(`/api/requirements/${id}/launch`); showCommand(plan.command); } catch (e) { toast(e.message, true); } return;
  }
  if (action === 'launch') return mutation('正在打开 Codex 终端', async () => { const r = await api(`/api/requirements/${id}/launch`, { method: 'POST', body: '{}' }); toast(r.message); });
  if (action === 'retry') return mutation('正在重试失败项目', async () => { const q = await api(`/api/requirements/${id}/retry`, { method: 'POST', body: '{}' }); toast(q.state === 'ready' ? '全部项目已就绪' : '仍有项目未就绪，请查看失败原因', q.state !== 'ready'); });
  if (action === 'archive') {
    const q = state.requirements.find(q => q.id === id);
    return mutation('正在更新任务状态', async () => { const r = await api(`/api/requirements/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived: q.state !== 'archived' }) }); toast(r.message); });
  }
  if (action === 'remove-project') {
    const p = state.projects.find(p => p.id === id);
    if (!confirm(`移除“${p.name}”的项目登记？\n仓库、分支和 worktree 文件均保留。`)) return;
    return mutation('正在移除登记', async () => { const r = await api(`/api/projects/${id}`, { method: 'DELETE' }); toast(r.message); });
  }
}
document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]'); if (action) handleAction(action.dataset.action, action);
  const nav = event.target.closest('[data-view]'); if (nav) navigate('/' + nav.dataset.view);
  if (event.target.closest('.close-dialog') && !state.busy) event.target.closest('dialog').close();
});
$('#newButton').addEventListener('click', () => state.view === 'requirements' ? openRequirement() : openProject());
$('#refreshButton').addEventListener('click', () => refresh(true));
$('#search').addEventListener('input', render);
$('#archiveFilter').addEventListener('change', render);
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); }));
$('#projectForm').addEventListener('submit', async event => {
  event.preventDefault(); const data = new FormData(event.target);
  const onAdded = projectAddedCallback;
  let added;
  await mutation('正在登记并扫描仓库', async () => {
    added = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: data.get('name'), path: data.get('path') }) });
    if (!onAdded) { state.selectedProject = added.id; navigate('/projects'); $('#search').value = ''; }
    $('#projectDialog').close(); toast('项目已登记，正在扫描 worktree');
  }, $('#projectError'));
  if (added && onAdded) onAdded(added.id);
});
$('#requirementForm').addEventListener('input', event => {
  const form = event.currentTarget;
  if (event.target.name === 'name' && !form.elements.slug.dataset.edited) {
    form.elements.slug.value = form.elements.name.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  if (event.target.name === 'slug') form.elements.slug.dataset.edited = '1';
  if ((event.target.name === 'name' || event.target.name === 'slug') && !form.elements.branch.dataset.edited) form.elements.branch.value = 'codex/' + form.elements.slug.value;
  if (event.target.name === 'branch') form.elements.branch.dataset.edited = '1';
  updatePreview();
});
$('#requirementForm').addEventListener('reset', event => { delete event.target.elements.slug.dataset.edited; delete event.target.elements.branch.dataset.edited; });
$('#requirementForm').addEventListener('change', updatePreview);
$('#requirementForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.target);
  const primary = data.get('primary_project_id');
  const projectIDs = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => i.value);
  const body = { name: data.get('name'), slug: data.get('slug'), description: data.get('description'), branch: data.get('branch'), primary_project_id: primary, project_ids: projectIDs };
  mutation('正在从 master 创建全部 Worktree', async () => {
    const q = await api('/api/requirements', { method: 'POST', body: JSON.stringify(body) });
    state.requirements.unshift(q); navigate('/requirements/' + q.id); $('#search').value = ''; $('#requirementDialog').close();
    toast(q.state === 'ready' ? '任务已创建，全部项目已就绪' : '任务已保存，部分项目创建失败，可单独重试', q.state !== 'ready');
  }, $('#requirementError'));
});
$('#copyCommand').addEventListener('click', () => copy($('#commandText').value));
window.addEventListener('DOMContentLoaded', () => {
  readRoute();
  render();
  refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
