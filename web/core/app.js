'use strict';

let refreshTimer;

async function refresh(force = false) {
  if (state.refreshing || state.busy) return;
  clearTimeout(refreshTimer);
  let nextRefresh = 10000;
  state.refreshing = true;
  const revision = environmentRevision;
  const needsScopedState = state.view !== 'requirements' || !!state.selectedRequirement;
  $('#refreshButton').disabled = true;
  try {
    const suffix = force ? '?refresh=1' : '';
    const [scoped, inventory] = await Promise.allSettled([
      needsScopedState ? api('/api/state' + suffix) : Promise.resolve(null),
      api('/api/task-inventory' + suffix, { environment: 'local' }),
    ]);
    if (revision !== environmentRevision) return;
    let changed = false;
    if (inventory.status === 'fulfilled') {
      changed = renderStateKey(taskInventory) !== renderStateKey(inventory.value);
      taskInventory = { ...inventory.value, loaded: true };
    }
    if (scoped.status === 'fulfilled' && scoped.value) {
      const data = scoped.value;
      changed = changed || !state.loaded || renderStateKey(state) !== renderStateKey(data);
      Object.assign(state, data, { loaded: true });
      if (typeof data.read_only_sessions === 'boolean') sessionReadOnly = data.read_only_sessions;
    }
    const failures = [];
    if (inventory.status === 'rejected') failures.push('全部任务刷新失败：' + inventory.reason.message);
    if (scoped.status === 'rejected') failures.push('当前环境连接失败：' + scoped.reason.message);
    for (const e of taskInventory.environments) if (e.error) failures.push(e.name + '：' + e.error);
    $('#offlineBanner').textContent = failures.join('\n');
    $('#offlineBanner').hidden = !failures.length;
    const pending = scoped.status === 'fulfilled' && scoped.value?.status_refreshing || inventory.status === 'fulfilled' && inventory.value.status_refreshing;
    nextRefresh = pending ? 1000 : 10000;
    $('#syncText').textContent = failures.length ? '部分环境异常' : pending ? '更新中…' : '已更新';
    $('#syncText').title = failures.length ? failures.join('\n') : pending ? '正在更新状态，当前显示最近结果' : '工作台状态已更新';
    $('#syncDot').classList.toggle('offline', !!failures.length);
    $('#syncDot').classList.toggle('updating', !!pending && !failures.length);
    if (changed || !state.loaded) { render(); refreshRequirementProjectPicker(); }
    else {
      updateCheckTimes();
      if (typeof refreshSessionWorkspace === 'function') refreshSessionWorkspace(false);
    }
  } catch (error) {
    if (revision !== environmentRevision || error.name === 'AbortError') return;
    $('#offlineBanner').textContent = '状态刷新失败：' + error.message;
    $('#offlineBanner').hidden = false;
    $('#syncText').textContent = '连接中断';
    $('#syncText').title = error.message;
    $('#syncDot').classList.remove('updating');
    $('#syncDot').classList.toggle('offline', true);
    if (!state.loaded) $('#content').innerHTML = window.WorkHubUI.offline();
  } finally {
    if (revision !== environmentRevision) return;
    state.refreshing = false; $('#refreshButton').disabled = false;
    if (!needsScopedState && (state.view !== 'requirements' || state.selectedRequirement)) nextRefresh = 0;
    refreshTimer = setTimeout(() => { if (!document.hidden) refresh(); }, nextRefresh);
  }
}

function renderStateKey(data) {
  // Once a result exists, polling metadata must not rebuild the workspace.
  // The first completed check still changes the key and enables its actions.
  return JSON.stringify([data.projects, data.requirements, data.terminal, data.master_sync, data.root, data.environments, data.project_count, data.read_only_sessions], function (key, value) {
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
  state.view = route === '/settings' ? 'settings' : route === '/projects' ? 'projects' : route === '/sessions' ? 'sessions' : 'requirements';
  const match = route.match(/^\/requirements\/([a-zA-Z0-9_-]+)$/);
  state.selectedRequirement = match ? match[1] : null;
}

function navigate(route) {
  if (location.hash === '#' + route) { readRoute(); render(); }
  else location.hash = route;
}
window.addEventListener('hashchange', () => {
  readRoute(); $('#search').value = '';
  render(); $('main').scrollTop = 0; $(state.view === 'projects' ? '#panelTitle' : '#pageTitle').focus({ preventScroll: true });
  refresh();
});
function render() {
  if (typeof saveTaskWorkspace === 'function') saveTaskWorkspace();
  const settingsView = state.view === 'settings';
  const sessionsView = state.view === 'sessions';
  const reqView = state.view === 'requirements';
  const detailView = reqView && !!state.selectedRequirement;
  const requirement = detailView ? state.requirements.find(q => q.id === state.selectedRequirement) : null;
  document.body.classList.toggle('task-detail-page', !!requirement);
  document.body.classList.toggle('projects-page', state.view === 'projects');
  $('#taskPageActions').hidden = !requirement;
  if (requirement) $('#taskPageActions').innerHTML = window.WorkHubUI.taskActions(requirement, environmentName());
  document.title = sessionsView ? '会话 · Work Hub' : settingsView ? '设置 · Work Hub' : requirement ? requirement.name + ' · Work Hub' : 'Work Hub';
  $('#backToRequirements').hidden = !detailView;
  $('.page-heading').hidden = state.view === 'projects';
  $('#stats').hidden = true;
  $('#panelToolbar').hidden = detailView;
  $('#newButton').hidden = detailView || settingsView || sessionsView;
  $('#settingsPage').hidden = !settingsView;
  $('#workContent').hidden = settingsView || sessionsView;
  $('#sessionsPage').hidden = !sessionsView;
  document.body.classList.toggle('sessions-page-open', sessionsView);
  $('#reqCount').textContent = taskInventory.requirements.filter(q => q.state !== 'archived').length;
  $('#projectCount').textContent = taskInventory.project_count;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#eyebrow').textContent = sessionsView ? 'SESSIONS' : settingsView ? 'SETTINGS' : detailView ? 'TASK' : reqView ? 'TASKS' : 'PROJECTS';
  $('#pageTitle').textContent = sessionsView ? '会话' : settingsView ? '设置' : detailView ? requirement?.name || '任务不存在' : reqView ? '任务' : '项目';
  $('#pageSubtitle').textContent = settingsView ? '管理执行环境、终端工具与每日更新。' : detailView ? '查看关联项目和 Codex 会话，继续当前任务中的开发。' : reqView ? '围绕一项开发目标，集中管理相关项目的工作目录、分支和会话。' : '登记项目，掌握它的全部工作目录、分支与任务归属。';
  $('#pageSubtitle').hidden = detailView || sessionsView;
  $('#newButton').innerHTML = `<span>＋</span> ${reqView ? '创建任务' : '添加项目'}`;
  $('#panelTitle').textContent = reqView ? '全部任务' : '已登记项目';
  $('#search').placeholder = reqView ? '搜索任务名称、说明…' : '搜索项目名称、目录…';
  $('#archiveFilterWrap').hidden = !reqView;
  $('#projectEnvironmentWrap').hidden = reqView;
  $('#projectAddButton').hidden = state.view !== 'projects';
  renderSettings();
  if (typeof syncSessionWorkspace === 'function') syncSessionWorkspace();
  if (settingsView || sessionsView) { if (typeof syncTaskWorkspace === 'function') syncTaskWorkspace(null); return; }
  $('#stats').innerHTML = '';
  $('#content').innerHTML = detailView
    ? requirement ? requirementDetail(requirement) : !state.loaded ? empty('暂时无法读取任务', '请检查任务所属环境的连接，可在设置中重新连接。') : empty('这个任务不存在', '可返回任务列表，重新选择一个任务。')
    : reqView ? renderRequirements() : renderProjects();
  if (state.view === 'projects') syncProjectResize();
  if (typeof refreshSessionWorkspace === 'function') refreshSessionWorkspace(false);
  if (typeof syncTaskWorkspace === 'function') syncTaskWorkspace(requirement);
  syncTaskDescription();
}

async function handleAction(action, target) {
  if (state.busy) return;
  const id = target.dataset.id;
  if (action === 'open-requirement') return selectEnvironment(target.dataset.environment, '/requirements/' + id);
  if (action === 'new-project') return openProject();
  if (action === 'new-worktree') return openWorktree(id);
  if (action === 'new-requirement') return openRequirement();
  if (action === 'edit-task') return openTaskEdit(id);
  if (action === 'change-task-directory') return openTaskDirectory(id, target.dataset.project);
  if (action === 'remove-task-project') return removeTaskProject(id, target.dataset.project);
  if (action === 'add-requirement-projects') return openRequirementProjects(id);
  if (action === 'select-project') { state.selectedProject = id; projectDetailOpen = true; render(); $('#projectDetail h2')?.focus({ preventScroll: true }); return; }
  if (action === 'project-list') { projectDetailOpen = false; render(); $('#content [aria-pressed="true"][data-action="select-project"]')?.focus(); return; }
  if (action === 'project-filter') { projectFilter = target.dataset.filter; projectDetailOpen = false; render(); $('#content [data-filter="' + projectFilter + '"]')?.focus(); return; }
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
  if (action === 'retry') return mutation('正在重试失败项目', async () => { const q = await api(`/api/requirements/${id}/retry`, { method: 'POST', body: JSON.stringify({project_id: target.dataset.project || ''}) }); toast(q.state === 'ready' ? '全部项目已就绪' : '仍有项目未就绪，请查看失败原因', q.state !== 'ready'); });
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
  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'open-requirement') {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
  }
  if (action) handleAction(action.dataset.action, action);
  const nav = event.target.closest('[data-view]'); if (nav) navigate('/' + nav.dataset.view);
  if (event.target.closest('.close-dialog') && !state.busy) event.target.closest('dialog').close();
});
$('#newButton').addEventListener('click', () => state.view === 'requirements' ? openRequirement() : openProject());
$('#refreshButton').addEventListener('click', () => refresh(true));
$('#search').addEventListener('input', () => { if (state.view === 'projects') projectDetailOpen = false; render(); });
$('#archiveFilter').addEventListener('change', render);
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); }));

$('#copyCommand').addEventListener('click', () => copy($('#commandText').value));
window.addEventListener('DOMContentLoaded', () => {
  readRoute();
  render();
  refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
