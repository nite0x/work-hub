'use strict';

let refreshTimer;

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

$('#copyCommand').addEventListener('click', () => copy($('#commandText').value));
window.addEventListener('DOMContentLoaded', () => {
  readRoute();
  render();
  refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
