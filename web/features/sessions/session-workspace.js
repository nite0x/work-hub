'use strict';

// One mounted browser moves between the standalone page and the native modal.
// Only the view's scope changes; session controllers remain keyed by environment
// and session ID, so drafts, attachments and reading position are shared.
const conversationViews = new Map();
const conversationIndex = new Map();
const conversationPageScopes = new Map();
const taskShortcutPins = new Map();
const directoryShortcutPins = new Map();
const shortcutPinLoads = new Map();
const shortcutPickerStates = new Map();
const conversationShortcutLoads = new Map();
const conversationWorkspaces = new Map();
let conversationView = null;
let conversationMode = 'hidden';
let conversationOrigin = '';
let conversationTrigger = null;
let conversationMoving = false;
let conversationSelection = 0;
const conversationHost = $('#sessionBrowser');
const conversationDialog = $('#conversationDialog');

// The same split survives transfers between the page and the conversation dialog.
window.WorkHubUI.setupConversationResize(conversationHost, window);
const conversationRequests = window.WorkHubUI.createSessionRequests();
const conversationPathKey = window.WorkHubUI.conversationPathKey;
const conversationScopeKey = (scope, environment = activeEnvironment) => JSON.stringify([environment, scope.kind, scope.id || '', scope.cwd || '', scope.environment || '']);
const conversationSessionKey = session => session.browser_key || session.id;
const conversationEnvironmentKey = window.WorkHubUI.conversationEnvironmentKey;
function conversationEnvironments() {
  const entries = [...taskInventory.environments, ...(typeof environmentInventory === 'undefined' ? [] : environmentInventory)];
  return [...new Map([{id: 'local', name: environmentName('local')}, ...entries].map(e => [e.id, e])).values()];
}
function conversationWorkspace(environment) {
  return environment === activeEnvironment ? state : conversationWorkspaces.get(environment) || {projects: [], requirements: []};
}
function conversationScopeEnvironment(scope) {
  if (scope.environment) return scope.environment;
  if (scope.kind === 'task') return (taskInventory.loaded ? taskInventory.requirements : state.requirements).find(t => t.id === scope.id)?.environment_id || activeEnvironment;
  return scope.kind === 'all' ? '' : activeEnvironment;
}
function conversationTaggedSession(session, environment) {
  return {...session, environment_id: environment, environment_name: environmentName(environment), browser_key: conversationEnvironmentKey(environment, session.id)};
}
function conversationVisible() { return conversationMode !== 'hidden' && !conversationHost.hidden; }
function conversationReadingSession(id, environment = activeEnvironment) {
  const width = conversationHost.getBoundingClientRect().width;
  return !document.hidden && window.WorkHubTab?.active !== false && conversationVisible() && !conversationView?.creating && conversationView?.selected === conversationEnvironmentKey(environment, id) && (conversationView.pane === 'detail' || !width || width > 620);
}
function conversationItems(environment) { return environment ? [...(conversationIndex.get(environment)?.values() || [])] : conversationEnvironments().flatMap(e => [...(conversationIndex.get(e.id)?.values() || [])]); }
function pinnedTaskIDs(environment = activeEnvironment) {
  if (!taskShortcutPins.has(environment)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('workhub:pinned-tasks:v1:' + environment)); } catch { /* Storage is optional. */ }
    taskShortcutPins.set(environment, Array.isArray(saved) ? [...new Set(saved.filter(id => typeof id === 'string'))] : []);
  }
  return taskShortcutPins.get(environment);
}
function pinnedDirectoryPaths(environment = activeEnvironment) {
  if (!directoryShortcutPins.has(environment)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('workhub:pinned-directories:v1:' + environment)); } catch { /* Storage is optional. */ }
    directoryShortcutPins.set(environment, Array.isArray(saved) ? [...new Map(saved.filter(path => typeof path === 'string' && path.trim()).map(path => [conversationPathKey(path), path])).values()] : []);
  }
  return directoryShortcutPins.get(environment);
}
function applyShortcutPins(environment, pins) {
  taskShortcutPins.set(environment, pins.tasks);
  directoryShortcutPins.set(environment, pins.directories);
  for (const [kind, values] of [['tasks', pins.tasks], ['directories', pins.directories]]) {
    const key = 'workhub:pinned-' + kind + ':v1:' + environment;
    try {
      if (values.length || localStorage.getItem(key) !== null) localStorage.setItem(key, JSON.stringify(values));
    } catch { /* The database is authoritative; browser storage is only a cache. */ }
  }
}
function loadShortcutPins(environment) {
  let load = shortcutPinLoads.get(environment);
  if (!load) { load = {loaded:false, pending:null, write:Promise.resolve(), revision:0, error:''}; shortcutPinLoads.set(environment, load); }
  if (load.loaded) return Promise.resolve();
  if (load.pending) return load.pending;
  const url = '/api/shortcut-pins?environment=' + encodeURIComponent(environment);
  load.pending = (async () => {
    try {
      let pins = await api(url, {environment:'local'});
      if (!pins.initialized) {
        pins = await api(url, {environment:'local', method:'PUT', body:JSON.stringify({tasks:pinnedTaskIDs(environment), directories:pinnedDirectoryPaths(environment), initialize:true})});
      }
      applyShortcutPins(environment, pins);
      load.saved = pins; load.loaded = true; load.error = '';
      renderConversationShortcuts(); updateDirectoryPinButton();
    } catch (error) {
      if (load.error !== error.message) toast('读取固定入口失败：' + error.message, true);
      load.error = error.message;
      throw error;
    } finally { load.pending = null; }
  })();
  return load.pending;
}
function saveShortcutPins(environment) {
  const load = shortcutPinLoads.get(environment);
  const pins = {tasks:[...pinnedTaskIDs(environment)], directories:[...pinnedDirectoryPaths(environment)]};
  const revision = ++load.revision;
  // Keep rapid clicks ordered, including task and directory changes together.
  load.write = load.write.then(async () => {
    try {
      load.saved = await api('/api/shortcut-pins?environment=' + encodeURIComponent(environment), {environment:'local', method:'PUT', body:JSON.stringify(pins)});
    } catch (error) {
      toast('保存固定入口失败：' + error.message, true);
    }
    if (load.revision === revision) {
      applyShortcutPins(environment, load.saved);
      renderConversationShortcuts(); updateDirectoryPinButton();
    }
  });
  return load.write;
}
function shortcutPickerState() {
  if (!shortcutPickerStates.has(activeEnvironment)) shortcutPickerStates.set(activeEnvironment, { search: '', archived: false });
  return shortcutPickerStates.get(activeEnvironment);
}
function syncShortcutPickerPanel() {
  const picker = $('#taskShortcutPicker');
  const panel = $('#shortcutPickerPanel');
  // The native top layer escapes the sidebar's scrolling and clipping boundary.
  if (!panel || typeof panel.showPopover !== 'function') return;
  if (!picker.open) { if (panel.matches(':popover-open')) panel.hidePopover(); return; }
  const anchor = picker.querySelector('summary').getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 18;
  const above = anchor.top - 18;
  const useBelow = below >= 300 || below >= above;
  panel.style.left = Math.max(12, Math.min(anchor.right - 340, window.innerWidth - 352)) + 'px';
  panel.style.top = useBelow ? anchor.bottom + 6 + 'px' : 'auto';
  panel.style.bottom = useBelow ? 'auto' : window.innerHeight - anchor.top + 6 + 'px';
  panel.style.maxHeight = Math.max(100, Math.min(540, useBelow ? below : above)) + 'px';
  if (!panel.matches(':popover-open')) panel.showPopover();
}
function shortcutTasks(includeArchived = false) {
  const tasks = taskInventory.loaded ? taskInventory.requirements : state.requirements;
  return tasks.filter(task => includeArchived || task.state !== 'archived');
}
function shortcutTaskKey(task) { return conversationEnvironmentKey(task.environment_id || activeEnvironment, task.id); }
function shortcutDirectories() {
  const paths = conversationDirectories({kind: 'all'}, '').filter(d => d.target).map(d => ({cwd: d.cwd, environment: d.environment}));
  for (const entry of conversationEnvironments()) for (const cwd of pinnedDirectoryPaths(entry.id)) paths.push({cwd, environment: entry.id});
  return [...new Map(paths.map(d => [conversationEnvironmentKey(d.environment, conversationPathKey(d.cwd)), d])).values()].map(({cwd, environment}) => {
    const key = conversationEnvironmentKey(environment, conversationPathKey(cwd));
    const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
    const name = parts.pop() || cwd;
    return {cwd, key, environment, name, parent: (parts.join(cwd.includes('\\') ? '\\' : '/') || '/') + ' · ' + environmentName(environment), pinned: pinnedDirectoryPaths(environment).some(path => conversationPathKey(path) === conversationPathKey(cwd))};
  });
}
function renderConversationShortcuts() {
  if (!window.document) return;
  const host = $('#conversationShortcuts');
  const tasks = shortcutTasks(true);
  const directories = shortcutDirectories();
  const selectedScope = conversationVisible() && conversationView?.environment === activeEnvironment ? conversationView.scope : null;
  const markup = window.WorkHubUI.conversationShortcuts({
    tasks: tasks.map(task => ({id:shortcutTaskKey(task), name:task.name, projects:[...new Set(task.members.map(m => m.project_name))].join(' · '), environment: environmentName(task.environment_id || activeEnvironment), pinned:pinnedTaskIDs(task.environment_id || activeEnvironment).includes(task.id), archived:task.state === 'archived'})),
    directories,
    pinnedDirectories: directories.filter(d => d.pinned),
    selected: selectedScope?.kind === 'task' ? conversationEnvironmentKey(selectedScope.environment, selectedScope.id) : null,
    selectedDirectory: selectedScope?.kind === 'directory' ? directories.find(directory => directory.environment === selectedScope.environment && conversationPathKey(directory.cwd) === conversationPathKey(selectedScope.cwd))?.key : null,
    ...shortcutPickerState(), environment: '全部环境',
  });
  if (host.dataset.markup !== markup) {
    const expanded = host.querySelector('#taskShortcutPicker')?.open;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focusID = focused?.id;
    const focusAttribute = ['data-task-shortcut', 'data-task-shortcut-pin', 'data-directory-shortcut', 'data-directory-shortcut-pin'].find(attribute => focused?.hasAttribute(attribute));
    const focusValue = focusAttribute && focused.getAttribute(focusAttribute);
    const selection = focused?.id === 'shortcutSearch' ? [focused.selectionStart, focused.selectionEnd] : null;
    const top = host.scrollTop;
    const resultsTop = host.querySelector('.shortcut-picker-results')?.scrollTop || 0;
    host.innerHTML = markup; host.dataset.markup = markup;
    if (expanded) { const picker = host.querySelector('#taskShortcutPicker'); picker.dataset.restored = 'true'; picker.open = true; }
    syncShortcutPickerPanel();
    host.scrollTop = top;
    host.querySelector('.shortcut-picker-results').scrollTop = resultsTop;
    if (focused) {
      const button = focusID ? host.querySelector('#' + focusID) : focusAttribute ? [...host.querySelectorAll('[' + focusAttribute + ']')].find(button => button.getAttribute(focusAttribute) === focusValue && (!button.closest('details') || button.closest('details').open)) : null;
      (button || host.querySelector('#taskShortcutPicker summary')).focus({preventScroll:true});
      if (selection && button) button.setSelectionRange(...selection);
    }
  }
}
function refreshConversationShortcuts(force = false) {
  return Promise.allSettled(conversationEnvironments().flatMap(entry => [loadShortcutPins(entry.id), refreshConversationEnvironment(entry.id, force)]));
}
function refreshConversationEnvironment(environment, force = false) {
  let load = conversationShortcutLoads.get(environment);
  if (!load) { load = {loading:false, checkedAt:0, revision:0, error:''}; conversationShortcutLoads.set(environment, load); }
  if (load.loading) return load.pending;
  if (!force && Date.now() - load.checkedAt < 10000) return;
  load.loading = true; load.checkedAt = Date.now();
  const revision = load.revision;
  renderConversationShortcuts();
  load.pending = (async () => {
    try {
      const result = await conversationRequests.load(api, environment, '', force);
      if (load.revision !== revision) return;
      conversationIndex.set(environment, new Map((result.sessions || []).map(s => [s.id, conversationTaggedSession(s, environment)])));
      load.error = result.error || '';
    } catch (error) {
      if (load.revision === revision) load.error = error.message;
    } finally {
      if (load.revision === revision) {
        load.loading = false;
        updateConversationNavigation();
      }
    }
  })();
  return load.pending;
}
function openTaskShortcut(id) {
  const task = shortcutTasks().find(task => shortcutTaskKey(task) === id);
  if (state.busy || !task) return;
  openConversationShortcut({kind:'task', id:task.id, environment:task.environment_id || activeEnvironment, name:task.name});
}
function openConversationShortcut(scope) {
  if (state.busy) return;
  rememberConversationView();
  const view = conversationViewFor(scope);
  Object.assign(view, {directory:'', search:'', statusFilter:'all', archived:false, requestedSession:null, creating:false, target:null, pane:'detail', sessions:view.sessions.filter(s => !s.archived), requestID:(view.requestID || 0) + 1, requestKey:null, loading:false, checkedAt:0});
  conversationPageScopes.set(activeEnvironment, scope);
  window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{phase:'before'}}));
  if (conversationDialog.open) { conversationMoving = true; conversationDialog.close(); conversationMoving = false; }
  document.body.classList.remove('conversation-modal-open');
  conversationMode = 'page'; $('#sessionPageMount').append(conversationHost);
  selectConversationScope(scope);
  rememberConversationView();
  navigate('/sessions');
  window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{visible:true}}));
}
function toggleTaskShortcutPin(key) {
  const task = shortcutTasks(true).find(task => shortcutTaskKey(task) === key);
  if (state.busy || !task) return;
  const environment = task.environment_id || activeEnvironment;
  if (!shortcutPinLoads.get(environment)?.loaded) return loadShortcutPins(environment).then(() => toggleTaskShortcutPin(key)).catch(() => {});
  const ids = pinnedTaskIDs(environment), id = task.id;
  if (!ids.includes(id) && task.state === 'archived') return;
  const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
  taskShortcutPins.set(environment, next);
  try { localStorage.setItem('workhub:pinned-tasks:v1:' + environment, JSON.stringify(next)); } catch { /* Keep memory fallback. */ }
  renderConversationShortcuts();
  return saveShortcutPins(environment);
}
function selectedConversationDirectoryKey() {
  const view = conversationView;
  return view?.directory || (view?.scope.kind === 'directory' ? conversationEnvironmentKey(view.scope.environment, conversationPathKey(view.scope.cwd)) : '');
}
function toggleDirectoryShortcutPin(key) {
  const directory = shortcutDirectories().find(d => d.key === key);
  if (state.busy || !directory) return;
  const {cwd, environment} = directory;
  if (!shortcutPinLoads.get(environment)?.loaded) return loadShortcutPins(environment).then(() => toggleDirectoryShortcutPin(key)).catch(() => {});
  const paths = pinnedDirectoryPaths(environment);
  const next = directory.pinned ? paths.filter(path => conversationPathKey(path) !== conversationPathKey(cwd)) : [...paths, cwd];
  directoryShortcutPins.set(environment, next);
  try { localStorage.setItem('workhub:pinned-directories:v1:' + environment, JSON.stringify(next)); } catch { /* Keep memory fallback. */ }
  renderConversationShortcuts(); updateDirectoryPinButton();
  return saveShortcutPins(environment);
}
function updateDirectoryPinButton() {
  const directory = shortcutDirectories().find(d => d.key === selectedConversationDirectoryKey());
  const button = $('#pinConversationDirectory');
  button.hidden = !directory;
  button.setAttribute('aria-pressed', String(!!directory?.pinned));
  button.querySelector('span').textContent = directory?.pinned ? '取消固定目录' : '固定此目录';
  button.setAttribute('aria-label', directory?.pinned ? '取消固定目录' : '固定此目录');
  button.title = directory?.cwd || '';
}
function conversationViewFor(scope) {
  if (scope.kind !== 'all' && !scope.environment) scope = {...scope, environment: conversationScopeEnvironment(scope)};
  const key = conversationScopeKey(scope);
  if (!conversationViews.has(key)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('workhub:conversation-view:v1:' + key)); } catch { /* Storage is optional. */ }
    conversationViews.set(key, { key, environment: activeEnvironment, environmentFilter: '', scope, directory: typeof saved?.directory === 'string' ? saved.directory : '', selected: typeof saved?.selected === 'string' ? saved.selected : undefined, archived: !!saved?.archived, search: '', statusFilter: 'all', pane: 'list', sessions: [], loading: false, error: '', checkedAt: 0, scrollTop: 0, creating: false });
  }
  return conversationViews.get(key);
}
function rememberConversationView() {
  const view = conversationView;
  if (!view) return;
  view.scrollTop = $('#sessionBrowserList').scrollTop;
  try { localStorage.setItem('workhub:conversation-view:v1:' + view.key, JSON.stringify({ directory: view.directory, selected: view.selected || null, archived: view.archived })); } catch { /* Keep memory fallback. */ }
  if (conversationMode === 'page') conversationPageScopes.set(activeEnvironment, view.scope);
}
function conversationDirectories(scope = conversationView?.scope, environmentFilter = conversationView?.environmentFilter || '') {
  if (!scope) return [];
  const result = [];
  let environment = conversationScopeEnvironment(scope);
  const add = (cwd, label, target, disabled = false) => {
    if (!cwd) return;
    const key = conversationEnvironmentKey(environment, conversationPathKey(cwd));
    const existing = result.find(d => d.key === key);
    if (!existing) result.push({ cwd, key, environment, label: label + ' · ' + environmentName(environment), target, disabled });
    else if (existing.disabled && !disabled) Object.assign(existing, { target, disabled });
  };
  const taskDirs = task => {
    if (task.has_workspace !== false) add(task.path, '任务目录（包含其中的 Worktree）· ' + task.name, { task_id: task.id, cwd: task.path }, task.state === 'archived');
    for (const m of task.members) add(m.path, m.project_name, { task_id: task.id, project_id: m.project_id, cwd: m.path }, task.state === 'archived' || m.state !== 'ready' || !canOpenMember(m));
  };
  const projectDirs = project => {
    for (const tree of project.worktrees || []) add(tree.path, project.name + ' · ' + (tree.branch || 'detached HEAD'), { project_id: project.id, cwd: tree.path }, !!(project.error || tree.bare || tree.missing || tree.prunable || tree.error));
    if (!(project.worktrees || []).some(t => conversationPathKey(t.path) === conversationPathKey(project.path))) add(project.path, project.name, { project_id: project.id, cwd: project.path }, true);
  };
  const workspace = conversationWorkspace(environment);
  if (environmentFilter && environment && environment !== environmentFilter) return [];
  if (scope.kind === 'task') {
    const task = workspace.requirements.find(q => q.id === scope.id) || taskInventory.requirements.find(q => q.id === scope.id && (q.environment_id || 'local') === environment);
    if (task) taskDirs(task);
    for (const session of conversationView?.scope.id === scope.id ? conversationView.sessions : []) add(session.cwd, session.cwd, null, true);
  } else if (scope.kind === 'project') {
    const project = workspace.projects.find(p => p.id === scope.id);
    if (project) projectDirs(project);
  } else {
    for (const entry of conversationEnvironments()) {
      if (environmentFilter && entry.id !== environmentFilter || scope.environment && entry.id !== scope.environment) continue;
      environment = entry.id;
      const data = conversationWorkspace(environment);
      data.projects.forEach(projectDirs);
      const tasks = taskInventory.loaded ? taskInventory.requirements.filter(q => (q.environment_id || 'local') === environment) : data.requirements;
      tasks.forEach(taskDirs);
      for (const session of conversationItems(environment)) add(session.cwd, session.cwd, null, true);
    }
    if (scope.kind === 'directory') {
      const matching = result.filter(d => conversationPathKey(d.cwd) === conversationPathKey(scope.cwd));
      return matching.length ? matching : [{ cwd: scope.cwd, key: conversationEnvironmentKey(scope.environment, conversationPathKey(scope.cwd)), environment: scope.environment, label: scope.cwd, target: null, disabled: true }];
    }
  }
  return result;
}
function conversationFilteredDirectories(view = conversationView) {
  const dirs = conversationDirectories(view.scope);
  return view.directory ? dirs.filter(d => d.key === view.directory) : dirs;
}
function conversationScopeName(scope) {
  if (scope.kind === 'all') return '全部对话';
  const data = conversationWorkspace(conversationScopeEnvironment(scope));
  if (scope.kind === 'task') return '任务 · ' + (data.requirements.find(q => q.id === scope.id)?.name || scope.name || scope.id);
  if (scope.kind === 'project') return '项目 · ' + (data.projects.find(p => p.id === scope.id)?.name || scope.name || scope.id);
  return '目录 · ' + scope.cwd;
}
function renderConversationScopes() {
  const tasks = taskInventory.loaded ? taskInventory.requirements : state.requirements;
  const scopes = [{ kind: 'all', name: '全部对话' }, ...tasks.map(q => ({ kind: 'task', id: q.id, environment: q.environment_id || activeEnvironment, name: q.name + ' · ' + environmentName(q.environment_id || activeEnvironment) })), ...conversationEnvironments().flatMap(e => conversationWorkspace(e.id).projects.map(p => ({ kind: 'project', id: p.id, environment: e.id, name: p.name + ' · ' + environmentName(e.id) }))), ...conversationDirectories({ kind: 'all' }, '').map(d => ({ kind: 'directory', cwd: d.cwd, environment: d.environment, name: d.cwd + ' · ' + environmentName(d.environment) }))];
  const search = $('#sessionScopeSearch').value.trim().toLowerCase();
  const matching = scopes.filter(s => !search || [s.name, s.cwd].join(' ').toLowerCase().includes(search));
  $('#sessionScopeOptions').innerHTML = matching.length ? window.WorkHubUI.conversationScopes(matching) : '<p class="session-empty">没有匹配的范围</p>';
}
function updateConversationNavigation() {
  if (!window.document) return;
  const items = conversationItems().filter(s => !s.archived);
  const waiting = items.filter(s => s.chat_status === 'waiting').length;
  const running = items.filter(s => conversationStatusMatches(s, 'running')).length;
  const unread = items.filter(s => sessionWithUnread(s).unread).length;
  const text = waiting ? '待确认' : running ? '运行中' : unread ? '有新消息' : '';
  const node = $('#sessionNavigationStatus');
  node.textContent = text; node.hidden = !text;
  node.setAttribute('aria-label', waiting ? `${waiting} 个会话待确认` : running ? `${running} 个会话运行中` : `${unread} 个会话有新消息`);
  renderConversationShortcuts();
}
function conversationStatusMatches(session, status) {
  if (status === 'running') return ['starting', 'running', 'stopping', 'handoff'].includes(session.chat_status);
  if (status === 'waiting') return session.chat_status === 'waiting';
  if (status === 'unread') return !!session.unread;
  return true;
}
function renderConversationList() {
  const view = conversationView;
  if (!view || view.environment !== activeEnvironment) return;
  const text = view.search.trim().toLowerCase();
  const matching = view.sessions.map(s => { const data = conversationWorkspace(s.environment_id || activeEnvironment); return {...sessionWithUnread(s), context: window.WorkHubUI.conversationContext(s.cwd, {tasks: data.requirements, projects: data.projects}, view.scope.kind === 'task' ? view.scope.id : undefined)}; }).filter(s => !text || [s.name, s.cwd, s.environment_name, s.context.project, s.context.branch, ...s.context.tasks.map(t => t.name)].join(' ').toLowerCase().includes(text));
  const statusFilter = view.statusFilter || 'all';
  const sessions = matching.filter(s => conversationStatusMatches(s, statusFilter)).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || (b.updated_at||0)-(a.updated_at||0));
  for (const button of document.querySelectorAll('[data-conversation-status]')) {
    const status = button.dataset.conversationStatus;
    const count = matching.filter(s => conversationStatusMatches(s, status)).length;
    button.setAttribute('aria-pressed', String(status === statusFilter));
    const badge = button.querySelector('[data-status-count]');
    badge.textContent = String(count); badge.hidden = status === 'all' || !count;
    button.setAttribute('aria-label', `${({all:'全部', running:'进行中', waiting:'待确认', unread:'未读'})[status]}，${view.error && !view.sessions.length ? '数量暂不可用' : count + ' 个对话'}`);
  }
  $('#sessionSearchClear').hidden = !view.search;
  const filterCount = Number(!!view.directory) + Number(!!view.archived) + Number(!!view.environmentFilter);
  $('#sessionClearFilters').hidden = !filterCount && statusFilter === 'all';
  const showContext = !view.directory && view.scope.kind !== 'directory' && new Set(view.sessions.map(session => conversationPathKey(session.cwd))).size > 1;
  const markup = view.error && !view.sessions.length && !view.loading ? '' : window.WorkHubUI.conversationList({ sessions, selected: view.creating ? null : view.selected, showDirectory: showContext, showContext, loading: view.loading, taskID: view.scope.kind === 'task' ? view.scope.id : undefined, filtered: !!text || !!filterCount || statusFilter !== 'all', error: false, canCreate: !$('#newBrowserSession').disabled });
  const list = $('#sessionBrowserList');
  if (list.innerHTML !== markup) {
    const top = list.scrollTop;
    const selected = list.contains(document.activeElement) ? document.activeElement?.dataset.conversationSession : null;
    const focusedMenu = document.activeElement?.closest('.session-item-menu');
    const focusedMenuID = focusedMenu?.dataset.sessionMenu;
    const focusedUnlink = document.activeElement?.hasAttribute('data-conversation-unlink');
    const expandedMenu = list.querySelector('.session-item-menu[open]')?.dataset.sessionMenu;
    list.innerHTML = markup;
    list.scrollTop = top;
    if (expandedMenu) [...list.querySelectorAll('[data-session-menu]')].find(menu => menu.dataset.sessionMenu === expandedMenu)?.setAttribute('open', '');
    if (selected) [...list.querySelectorAll('[data-conversation-session]')].find(b => b.dataset.conversationSession === selected)?.focus({ preventScroll: true });
    if (focusedMenuID) {
      const menu = [...list.querySelectorAll('[data-session-menu]')].find(menu => menu.dataset.sessionMenu === focusedMenuID);
      menu?.querySelector(focusedUnlink ? '[data-conversation-unlink]' : 'summary')?.focus({preventScroll:true});
    }
  }
  const running = sessions.filter(s => ['starting','running','stopping','handoff'].includes(s.chat_status)).length;
  const waiting = sessions.filter(s => s.chat_status === 'waiting').length;
  const countMarkup = view.error && !view.sessions.length ? '<span>数量暂不可用</span>' : `<span>${sessions.length}${text || statusFilter !== 'all' ? ' / ' + view.sessions.length : ''} 个对话${view.error ? ' · 部分结果未更新' : ''}</span><span class="sr-only">${running ? ` · ${running} 个运行中` : ''}${waiting ? ` · ${waiting} 个待确认` : ''}${view.loading ? ' · 更新中' : ''}</span>`;
  if ($('#sessionBrowserCount').innerHTML !== countMarkup) $('#sessionBrowserCount').innerHTML = countMarkup;
  const refresh = $('[data-conversation-action="refresh"]');
  refresh.classList.toggle('is-loading', view.loading);
  refresh.disabled = view.loading;
  refresh.setAttribute('aria-label', view.loading ? '正在刷新对话列表' : '刷新会话列表');
  $('#sessionBrowserError').hidden = !view.error;
  const errorMarkup = view.error ? `<strong>${view.sessions.length ? '部分对话未能刷新' : '暂时无法读取对话'}</strong><p>${view.sessions.length ? '保留上次结果，你可以继续查看已有对话。' : '检查执行环境连接后重试。'}</p><button type="button" data-conversation-action="refresh" class="session-error-retry">重新加载</button><details><summary>错误详情</summary><pre>${esc(view.error)}</pre></details>` : '';
  if ($('#sessionBrowserError').innerHTML !== errorMarkup) $('#sessionBrowserError').innerHTML = errorMarkup;
  updateConversationNavigation();
}
function renderConversationBrowser() {
  const view = conversationView;
  if (!view) return;
  const panelWorkspace = conversationWorkspace(sessionHistoryState?.environment || activeEnvironment);
  window.WorkHubAssistant?.updateWorkspace?.({tasks: panelWorkspace.requirements, projects: panelWorkspace.projects});
  conversationHost.hidden = conversationMode === 'hidden';
  conversationHost.dataset.pane = view.pane;
  $('#sessionBrowserScopeBar').hidden = conversationMode !== 'page';
  $('#sessionScopeLabel').textContent = conversationScopeName(view.scope);
  $('#sessionBrowserContext').textContent = conversationScopeName(view.scope) + ' · ' + (view.environmentFilter || conversationScopeEnvironment(view.scope) ? environmentName(view.environmentFilter || conversationScopeEnvironment(view.scope)) : '全部环境');
  $('#sessionsEnvironment').value = view.environmentFilter;
  $('#sessionEnvironmentField').hidden = conversationEnvironments().length < 2 || !!conversationScopeEnvironment(view.scope);
  $('#sessionScopeAll').hidden = view.scope.kind === 'all';
  $('#conversationDialogTitle').textContent = conversationScopeName(view.scope) + ' · 对话';
  const dirs = conversationDirectories();
  const missingDirectory = view.directory && !dirs.some(d => d.key === view.directory);
  $('#taskConversationTools').hidden = view.scope.kind !== 'task';
  $('#linkTaskConversation').dataset.requirement = view.scope.kind === 'task' ? view.scope.id : '';
  $('#linkTaskConversation').dataset.environment = conversationScopeEnvironment(view.scope);
  $('#conversationDialogScope').textContent = view.scope.kind === 'task' ? '与这项工作明确关联的会话 · 独立保存和运行' : view.scope.kind === 'project' ? `项目下的 ${dirs.length} 个工作目录` : view.scope.cwd || '全部工作目录';
  $('#sessionDirectoryField').hidden = (!view.directory && dirs.length < 2) || view.scope.kind === 'directory';
  const filter = $('#sessionDirectoryFilter');
  const options = '<option value="">全部目录</option>' + dirs.map(d => `<option value="${esc(d.key)}">${esc(d.label)} · ${esc(d.cwd)}</option>`).join('') + (missingDirectory ? `<option value="${esc(view.directory)}">目录待核实 · ${esc(view.directory)}</option>` : '');
  if (filter.innerHTML !== options) filter.innerHTML = options;
  filter.value = view.directory;
  updateDirectoryPinButton();
  $('#sessionBrowserSearch').value = view.search;
  $('#sessionBrowserArchived').checked = !!view.archived;
  const filterCount = Number(!!view.directory) + Number(!!view.archived) + Number(!!view.environmentFilter);
  $('#sessionFilterCount').textContent = String(filterCount);
  $('#sessionFilterCount').hidden = !filterCount;
  $('#sessionClearFilters').hidden = !filterCount;
  $('#sessionFilterPicker').classList.toggle('has-filters', !!filterCount);
  $('#sessionFilterPicker').querySelector('summary').title = [view.directory, view.archived ? '已归档对话' : '', view.environmentFilter ? environmentName(view.environmentFilter) : ''].filter(Boolean).join(' · ') || '筛选环境、目录与归档';
  $('#sessionActiveFilterLabel').hidden = !filterCount;
  const directoryPath = dirs.find(d => d.key === view.directory)?.cwd || view.directory;
  $('#sessionActiveFilterLabel').textContent = [directoryPath ? directoryPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || directoryPath : '', view.archived ? '已归档' : '', view.environmentFilter ? environmentName(view.environmentFilter) : ''].filter(Boolean).join(' · ');
  $('#sessionActiveFilterLabel').title = directoryPath;
  const available = conversationFilteredDirectories().filter(d => !d.disabled && d.target);
  $('#newBrowserSession').disabled = sessionReadOnly || !available.length;
  $('#newBrowserSession').title = sessionReadOnly ? '当前为只读模式，请在终端新建对话' : !available.length ? '当前范围没有可用于新建对话的工作目录' : '';
  $('#sessionBrowserNewDirectoryField').hidden = !view.creating || available.length < 2;
  if (view.creating) {
    $('#sessionBrowserNewDirectory').innerHTML = '<option value="">请选择工作目录</option>' + available.map(d => `<option value="${esc(d.key)}">${esc(d.label)} · ${esc(d.cwd)}</option>`).join('');
    $('#sessionBrowserNewDirectory').value = view.target ? conversationEnvironmentKey(view.targetEnvironment, conversationPathKey(view.target.cwd)) : '';
  }
  const extraField = $('#sessionBrowserAdditionalField');
  const extraDirs = view.creating && view.target?.task_id ? available.filter(d => d.environment === view.targetEnvironment && d.target?.project_id && d.cwd !== view.target.cwd) : [];
  extraField.hidden = !extraDirs.length;
  if (extraDirs.length) {
    const markup = extraDirs.map(d => `<label class="task-additional-directory"><input type="checkbox" data-additional-directory="${esc(d.cwd)}" ${view.target.additional_directories?.includes(d.cwd) ? 'checked' : ''} />${esc(d.label)}<small>${esc(d.cwd)}</small></label>`).join('');
    if ($('#sessionBrowserAdditionalDirectories').innerHTML !== markup) $('#sessionBrowserAdditionalDirectories').innerHTML = markup;
  }
  renderConversationList();
}
async function refreshSessionWorkspace(force = false) {
  const shortcuts = refreshConversationShortcuts(force);
  if (!conversationVisible()) return shortcuts;
  const view = conversationView;
  if (!view || view.environment !== activeEnvironment || view.loading || !force && Date.now() - view.checkedAt < 10000) return;
  const directory = view.directory;
  const requestKey = JSON.stringify([view.scope, directory, !!view.archived, view.environmentFilter]);
  const requestID = (view.requestID || 0) + 1;
  view.requestID = requestID;
  const scopeEnvironment = conversationScopeEnvironment(view.scope);
  let selectedDirectory = conversationDirectories().find(d => d.key === directory);
  if (directory && !selectedDirectory) {
    let identity;
    try { identity = JSON.parse(directory); } catch { /* Local directory keys are paths. */ }
    selectedDirectory = Array.isArray(identity) && identity.length === 2 ? {environment: identity[0], cwd: identity[1]} : {environment: 'local', cwd: directory};
  }
  const environments = conversationEnvironments().filter(e => (!scopeEnvironment || e.id === scopeEnvironment) && (!view.environmentFilter || e.id === view.environmentFilter) && (!selectedDirectory || e.id === selectedDirectory.environment));
  const params = new URLSearchParams();
  if (view.archived) params.set('archived', 'true');
  if (view.scope.kind === 'task') { params.set('task_id', view.scope.id); params.set('linked', 'true'); }
  if (view.scope.kind === 'project') params.set('project_id', view.scope.id);
  const cwd = selectedDirectory?.cwd || directory || (view.scope.kind === 'directory' ? view.scope.cwd : '');
  if (cwd) params.set('cwd', cwd);
  const sameScope = view.requestKey === requestKey;
  view.loading = true; view.error = ''; view.requestKey = requestKey; view.checkedAt = Date.now();
  renderConversationList();
  const results = new Map(), errors = new Map();
  const previousSessions = sameScope ? view.sessions : [];
  const pendingEnvironments = new Set(environments.map(e => e.id));
  const selectionEnvironment = () => {
    const selected = previousSessions.find(s => conversationSessionKey(s) === view.selected);
    if (selected) return selected.environment_id;
    try { const key = JSON.parse(view.selected); if (Array.isArray(key)) return key[0]; } catch { /* Local IDs are plain strings. */ }
    return 'local';
  };
  const current = () => view.requestID === requestID && view.requestKey === requestKey && view.environment === activeEnvironment;
  function publish() {
    if (!current()) return;
    view.sessions = [...results.values()].flat().concat(previousSessions.filter(s => pendingEnvironments.has(s.environment_id) || errors.has(s.environment_id) && !results.has(s.environment_id))).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    view.error = [...errors.values()].join('\n');
    if (view.requestedSession) {
      if (view.sessions.some(s => conversationSessionKey(s) === view.requestedSession)) view.requestedSession = null;
    } else if (!view.creating && !(view.selected && pendingEnvironments.has(selectionEnvironment())) && !view.sessions.some(s => conversationSessionKey(s) === view.selected)) view.selected = view.sessions[0] ? conversationSessionKey(view.sessions[0]) : undefined;
    if (view === conversationView && conversationVisible()) {
      renderConversationBrowser();
      if (!view.creating) showConversationSelection();
    }
    updateConversationNavigation();
  }
  await Promise.allSettled(environments.map(async ({id: environment}) => {
    // Project state supplies creation targets and context; session listing does
    // not wait for a slow repository scan in another environment.
    if (environment !== activeEnvironment) api('/api/state', {environment}).then(data => {
      if (!current()) return;
      conversationWorkspaces.set(environment, data);
      if (view === conversationView && conversationVisible()) renderConversationBrowser();
    }).catch(() => {});
    try {
      const result = await conversationRequests.load(api, environment, params.toString(), force);
      if (!current()) return;
      const sessions = (Array.isArray(result.sessions) ? result.sessions : []).map(s => conversationTaggedSession(s, environment));
      if (!result.error || sessions.length) results.set(environment, sessions);
      if (result.error) errors.set(environment, environmentName(environment) + '：' + result.error);
      let index = conversationIndex.get(environment) || new Map();
      if (view.scope.kind === 'all' && !directory && !view.archived) index = new Map();
      for (const session of sessions) index.set(session.id, session);
      conversationIndex.set(environment, index);
    } catch (error) {
      if (!current()) return;
      errors.set(environment, environmentName(environment) + '：' + error.message);
    }
    pendingEnvironments.delete(environment);
    publish();
  }));
  if (!current()) return;
  view.loading = false;
  if (view.requestedSession) errors.set('selection', '该对话暂不可用，请刷新列表重试。');
  publish();
}
function showConversationSelection() {
  const view = conversationView;
  if (!view || !conversationVisible()) return;
  const session = view.creating ? null : view.sessions.find(s => conversationSessionKey(s) === view.selected);
  if (view.creating && !view.target || !view.creating && !session) {
    closeSessionHistory(false);
    $('#sessionBrowserEmpty').hidden = false;
    $('#sessionBrowserEmpty').textContent = view.creating ? '选择本次对话的工作目录。' : view.loading ? '正在读取对话…' : view.error ? '暂时无法读取对话，请点击列表中的刷新重试。' : '这里还没有对话，可以从列表上方新建。';
    if (!view.creating && !view.loading && view.error) $('#sessionBrowserEmpty').hidden = true;
    return;
  }
  const targetKey = JSON.stringify(view.target || null);
  if (session && conversationReadingSession(session.id, session.environment_id)) saveSessionRead(session);
  if (session) rememberConversationView();
  const environment = session?.environment_id || view.targetEnvironment || conversationScopeEnvironment(view.scope) || activeEnvironment;
  if (sessionHistoryState?.environment === environment && (session ? sessionHistoryState.session === session.id : !sessionHistoryState.session && sessionHistoryState.browserTarget === targetKey)) {
    if (session) window.WorkHubAssistant?.updateSession?.(session);
    return;
  }
  $('#sessionBrowserEmpty').hidden = true;
  const selection = ++conversationSelection;
  const tools = conversationHost.querySelector('.session-browser-list-tools');
  const focusedControl = tools.contains(document.activeElement) ? document.activeElement : null;
  openSessionHistoryPanel(view.scope.kind === 'task' ? view.scope.id : null, session?.id || null, {
    session, environment, workspace: conversationWorkspace(environment), target: view.target, browserTarget: targetKey,
    created(created) {
      conversationRequests.invalidate(environment);
      created = conversationTaggedSession(created, environment);
      const index = conversationIndex.get(environment) || new Map();
      index.set(created.id, created); conversationIndex.set(environment, index);
      if (!view.sessions.some(s => conversationSessionKey(s) === conversationSessionKey(created))) view.sessions.unshift(created);
      if (conversationView !== view || selection !== conversationSelection) return;
      view.selected = conversationSessionKey(created); view.creating = false; view.target = null; view.search = ''; view.statusFilter = 'all';
      renderConversationBrowser(); rememberConversationView();
    }
  });
  // Background selection after filtering must not pull focus out of the controls.
  if (focusedControl?.isConnected && !focusedControl.closest('[hidden]') && (!focusedControl.closest('details:not([open])') || focusedControl.matches('summary'))) focusedControl.focus({preventScroll:true});
  renderConversationList();
}
function selectConversationScope(scope) {
  const pickerFocused = $('#sessionScopePicker').contains(document.activeElement);
  rememberConversationView();
  conversationSelection++;
  closeSessionHistory(false);
  conversationView = conversationViewFor(scope);
  $('#sessionScopePicker').open = false;
  $('#sessionScopeSearch').value = '';
  $('#sessionFilterPicker').open = false;
  if (pickerFocused) $('#sessionScopePicker summary').focus({preventScroll:true});
  renderConversationBrowser(); refreshSessionWorkspace(true); showConversationSelection();
  $('#sessionBrowserList').scrollTop = conversationView.scrollTop;
}
function openConversationWorkspace(scope, session, trigger) {
  if (state.busy) return;
  conversationTrigger = trigger || document.activeElement;
  conversationOrigin = location.hash;
  conversationMode = 'modal';
  $('#sessionModalMount').append(conversationHost);
  if (!conversationDialog.open) conversationDialog.showModal();
  selectConversationScope(scope);
  if (session) {
    const environment = conversationScopeEnvironment(conversationView.scope) || activeEnvironment;
    const cached = conversationItems(environment).find(s => s.id === session) || requirementSessions.get(scope.id)?.sessions.find(s => s.id === session);
    if (cached && !conversationView.sessions.some(s => conversationSessionKey(s) === conversationEnvironmentKey(environment, session))) conversationView.sessions.unshift(conversationTaggedSession(cached, environment));
    conversationView.selected = conversationEnvironmentKey(environment, session);
    conversationView.pane = 'detail';
    renderConversationBrowser(); showConversationSelection();
  }
  document.body.classList.add('conversation-modal-open');
  $('#conversationDialogTitle').textContent = conversationScopeName(scope) + ' · 对话';
  $('[data-conversation-action="close"]').focus();
}
function closeConversationWorkspace(restoreFocus = true) {
  rememberConversationView();
  conversationSelection++;
  conversationMode = 'hidden';
  conversationHost.hidden = true;
  document.body.classList.remove('conversation-modal-open');
  closeSessionHistory(false);
  if (conversationDialog.open) conversationDialog.close();
  renderConversationShortcuts();
  if (restoreFocus) {
    const action = conversationView?.scope.kind === 'task' ? 'task-conversations' : 'project-conversations';
    const id = conversationView?.scope.id;
    const trigger = conversationTrigger?.isConnected ? conversationTrigger : [...document.querySelectorAll(`[data-action="${action}"]`)].find(b => b.dataset.id === id);
    (trigger || $('#pageTitle')).focus({ preventScroll: true });
  }
}
function suspendSessionWorkspace() {
  for (const environment of conversationEnvironments()) conversationRequests.invalidate(environment.id);
  if (state.loaded) conversationWorkspaces.set(activeEnvironment, {...state});
  closeConversationWorkspace(false);
  for (const load of conversationShortcutLoads.values()) { load.revision++; load.loading = false; load.checkedAt = 0; }
  for (const view of conversationViews.values()) { view.requestID = (view.requestID || 0) + 1; view.loading = false; }
  conversationView = null;
  updateConversationNavigation();
}
function syncSessionWorkspace() {
  if (conversationView && conversationView.environment !== activeEnvironment) suspendSessionWorkspace();
  if (conversationMode === 'modal' && conversationOrigin !== location.hash && state.view !== 'sessions') closeConversationWorkspace(false);
  if (state.view === 'sessions') {
    if (conversationMode !== 'page') {
      if (conversationDialog.open) { conversationMoving = true; conversationDialog.close(); conversationMoving = false; document.body.classList.remove('conversation-modal-open'); }
      conversationMode = 'page';
      $('#sessionPageMount').append(conversationHost);
      selectConversationScope(conversationPageScopes.get(activeEnvironment) || { kind: 'all', name: '全部会话' });
    }
    renderConversationBrowser();
    refreshSessionWorkspace(false);
  } else if (conversationMode === 'page') closeConversationWorkspace(false);
  else if (conversationMode === 'modal') renderConversationBrowser();
  updateConversationNavigation();
  refreshConversationShortcuts();
}
function openSessionWorkspaceHistory(requirement, session) {
  openConversationWorkspace(requirement ? { kind: 'task', id: requirement } : { kind: 'all', name: '全部会话' }, session);
  if (!session && !sessionReadOnly) startBrowserConversation();
}
function startBrowserConversation() {
  const view = conversationView;
  const dirs = conversationFilteredDirectories().filter(d => !d.disabled && d.target);
  if (sessionReadOnly || !dirs.length) return;
  view.creating = true; view.selected = null; view.pane = 'detail';
  view.target = dirs.length === 1 ? browserCreationTarget(dirs[0]) : null;
  view.targetEnvironment = dirs.length === 1 ? dirs[0].environment : null;
  conversationSelection++;
  closeSessionHistory(false);
  renderConversationBrowser(); showConversationSelection();
  ($('#sessionBrowserNewDirectoryField').hidden ? $('#assistantChatRoot textarea') : $('#sessionBrowserNewDirectory'))?.focus();
}
function browserSessionActivity(id, chat, environment = activeEnvironment) {
  const item = conversationIndex.get(environment)?.get(id);
  if (item) { item.chat_status = chat.busy ? chat.status : ''; if (!chat.busy && chat.turn_id) item.completed_run = chat.id; }
  for (const view of conversationViews.values()) {
    const s = view.sessions.find(s => s.id === id && s.environment_id === environment);
    if (s) { s.chat_status = chat.busy ? chat.status : ''; if (!chat.busy && chat.turn_id) s.completed_run = chat.id; }
  }
  if (conversationVisible()) renderConversationList(); else updateConversationNavigation();
}
document.addEventListener('click', event => {
  const directoryShortcut = event.target.closest('[data-directory-shortcut]');
  if (directoryShortcut) {
    const directory = shortcutDirectories().find(d => d.key === directoryShortcut.dataset.directoryShortcut);
    if (directory) openConversationShortcut({kind:'directory', cwd:directory.cwd, environment:directory.environment, name:directory.cwd});
    return;
  }
  const directoryPin = event.target.closest('[data-directory-shortcut-pin]');
  if (directoryPin && !directoryPin.disabled) return toggleDirectoryShortcutPin(directoryPin.dataset.directoryShortcutPin);
  const shortcut = event.target.closest('[data-task-shortcut]');
  if (shortcut) return openTaskShortcut(shortcut.dataset.taskShortcut);
  const pin = event.target.closest('[data-task-shortcut-pin]');
  if (pin && !pin.disabled) return toggleTaskShortcutPin(pin.dataset.taskShortcutPin);
  const entry = event.target.closest('[data-action="task-conversations"], [data-action="project-conversations"]');
  if (entry) return openConversationWorkspace({ kind: entry.dataset.action === 'task-conversations' ? 'task' : 'project', id: entry.dataset.id }, undefined, entry);
  const session = event.target.closest('[data-conversation-session]');
  if (session && conversationView) {
    conversationView.requestedSession = null;
    conversationView.selected = session.dataset.conversationSession; conversationView.creating = false; conversationView.target = null; conversationView.pane = 'detail';
    conversationSelection++; renderConversationBrowser(); showConversationSelection(); rememberConversationView(); return;
  }
  const scope = event.target.closest('[data-conversation-scope]');
  if (scope) { selectConversationScope(JSON.parse(scope.dataset.conversationScope)); rememberConversationView(); return; }
  const statusButton = event.target.closest('[data-conversation-status]');
  if (statusButton && conversationView) {
    conversationView.statusFilter = statusButton.dataset.conversationStatus;
    $('#sessionBrowserList').scrollTop = 0;
    renderConversationList(); return;
  }
  const button = event.target.closest('[data-conversation-action]');
  if (!button || button.disabled || state.busy) return;
  switch (button.dataset.conversationAction) {
    case 'new': startBrowserConversation(); break;
    case 'pin-directory': toggleDirectoryShortcutPin(selectedConversationDirectoryKey()); break;
    case 'close': closeConversationWorkspace(); break;
    case 'refresh': refreshSessionWorkspace(true); break;
    case 'refresh-shortcuts': refreshConversationShortcuts(true); break;
    case 'close-filters':
      $('#sessionFilterPicker').open = false; $('#sessionFilterPicker summary').focus(); break;
    case 'clear-search':
      conversationView.search = ''; $('#sessionBrowserSearch').value = ''; $('#sessionBrowserList').scrollTop = 0;
      renderConversationList(); $('#sessionBrowserSearch').focus(); break;
    case 'reset-list':
      conversationView.search = ''; $('#sessionBrowserSearch').value = '';
      resetConversationListFilters(); $('#sessionBrowserSearch').focus(); break;
    case 'clear-filters':
      resetConversationListFilters(); break;
    case 'all': selectConversationScope({ kind: 'all', name: '全部会话' }); rememberConversationView(); break;
    case 'back': {
      conversationView.pane = 'list'; renderConversationBrowser();
      const selected = [...$('#sessionBrowserList').querySelectorAll('[data-conversation-session]')].find(item => item.dataset.conversationSession === conversationView.selected);
      (selected || $('#sessionBrowserSearch')).focus({preventScroll:true});
      selected?.scrollIntoView({block:'nearest'});
      break;
    }
    case 'page': {
      rememberConversationView(); conversationPageScopes.set(activeEnvironment, conversationView.scope);
      window.dispatchEvent(new CustomEvent('workhub:chat-layout', { detail: { phase: 'before' } }));
      conversationMoving = true;
      conversationDialog.close();
      conversationMoving = false;
      document.body.classList.remove('conversation-modal-open');
      conversationMode = 'page'; $('#sessionPageMount').append(conversationHost);
      navigate('/sessions'); renderConversationBrowser();
      window.dispatchEvent(new CustomEvent('workhub:chat-layout', { detail: { visible: true } }));
      break;
    }
  }
});
function resetConversationListFilters() {
  const view = conversationView;
  const reload = !!(view.environmentFilter || view.directory || view.archived);
  view.statusFilter = 'all'; view.environmentFilter = ''; view.archived = false;
  $('#sessionBrowserArchived').checked = false;
  $('#sessionFilterPicker').open = false;
  if (reload) {
    $('#sessionDirectoryFilter').value = '';
    $('#sessionDirectoryFilter').dispatchEvent(new Event('change', {bubbles:true}));
  } else renderConversationBrowser();
}
$('#sessionDirectoryFilter').addEventListener('change', event => {
  if (!conversationView) return;
  rememberConversationView(); conversationSelection++;
  closeSessionHistory(false);
  conversationView.directory = event.target.value; conversationView.selected = undefined; conversationView.creating = false; conversationView.target = null; conversationView.pane = 'list'; conversationView.sessions = []; conversationView.checkedAt = 0;
  conversationView.requestedSession = null;
  // Invalidate the previous request before allowing a different directory query.
  conversationView.requestID = (conversationView.requestID || 0) + 1;
  conversationView.requestKey = null; conversationView.loading = false;
  renderConversationBrowser(); refreshSessionWorkspace(true); showConversationSelection();
});
$('#sessionBrowserSearch').addEventListener('input', event => { if (conversationView) { conversationView.search = event.target.value; $('#sessionBrowserList').scrollTop = 0; renderConversationList(); } });
$('#sessionsEnvironment').addEventListener('change', event => {
  if (!conversationView) return;
  conversationView.environmentFilter = event.target.value;
  $('#sessionDirectoryFilter').value = '';
  $('#sessionDirectoryFilter').dispatchEvent(new Event('change', {bubbles: true}));
});
$('#sessionScopeSearch').addEventListener('input', renderConversationScopes);
document.addEventListener('input', event => {
  if (event.target.id !== 'shortcutSearch') return;
  shortcutPickerState().search = event.target.value;
  renderConversationShortcuts();
});
document.addEventListener('change', event => {
  if (event.target.id !== 'shortcutArchived') return;
  shortcutPickerState().archived = event.target.checked;
  renderConversationShortcuts();
});
document.addEventListener('toggle', event => {
  if (event.target.id !== 'taskShortcutPicker') return;
  syncShortcutPickerPanel();
  if (!event.target.open) return;
  if (event.target.dataset.restored) { delete event.target.dataset.restored; return; }
  $('#shortcutSearch')?.focus({preventScroll:true});
  if (!state.loaded && !state.refreshing) refresh(true);
}, true);
window.addEventListener('resize', syncShortcutPickerPanel);
$('#sessionScopePicker').addEventListener('toggle', () => { if ($('#sessionScopePicker').open) { renderConversationScopes(); $('#sessionScopeSearch').focus(); } });
$('#sessionBrowserNewDirectory').addEventListener('change', event => {
  if (!conversationView?.creating) return;
  const directory = conversationFilteredDirectories().find(d => d.key === event.target.value);
  conversationView.target = directory ? browserCreationTarget(directory) : null;
  conversationView.targetEnvironment = directory?.environment;
  conversationSelection++; closeSessionHistory(false); renderConversationBrowser(); showConversationSelection();
});
conversationDialog.addEventListener('close', () => { if (!conversationMoving && conversationMode === 'modal') closeConversationWorkspace(); });
conversationDialog.addEventListener('cancel', event => { event.preventDefault(); if (!state.busy) closeConversationWorkspace(); });
document.addEventListener('keydown', event => {
  const itemMenu = document.activeElement?.closest('.session-item-menu[open]');
  if (event.key === 'Escape' && itemMenu) { itemMenu.open = false; itemMenu.querySelector('summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
  if (event.key === 'Escape' && $('#taskShortcutPicker')?.open) { $('#taskShortcutPicker').open = false; $('#taskShortcutPicker summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
  if (event.key === 'Escape' && $('#sessionFilterPicker').open) { $('#sessionFilterPicker').open = false; $('#sessionFilterPicker summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
  if (event.key === 'Escape' && $('#sessionScopePicker').open) { $('#sessionScopePicker').open = false; $('#sessionScopePicker summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
  if (event.key === 'Escape' && event.target.id === 'sessionBrowserSearch' && conversationView?.search) {
    conversationView.search = ''; event.target.value = ''; renderConversationList(); event.preventDefault(); event.stopPropagation(); return;
  }
  const item = event.target.closest('[data-conversation-session]');
  if (!item && !(event.target.id === 'sessionBrowserSearch' && event.key === 'ArrowDown')) return;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...$('#sessionBrowserList').querySelectorAll('[data-conversation-session]')];
  if (!items.length) return;
  const index = items.indexOf(item);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
  items[next].focus({preventScroll:true}); items[next].scrollIntoView({block:'nearest'}); event.preventDefault();
}, true);
for (const id of ['sessionFilterPicker', 'sessionScopePicker']) {
  const picker = $('#' + id);
  const other = $('#' + (id === 'sessionFilterPicker' ? 'sessionScopePicker' : 'sessionFilterPicker'));
  picker.addEventListener('toggle', () => {
    if (!window.document || !picker.open) return;
    other.open = false;
  });
}
document.addEventListener('click', event => { if (!event.target.closest('#sessionScopePicker')) $('#sessionScopePicker').open = false; });
document.addEventListener('click', event => { if (!event.target.closest('#sessionFilterPicker')) $('#sessionFilterPicker').open = false; });
document.addEventListener('click', event => { const picker = $('#taskShortcutPicker'); if (picker && !event.target.closest('#taskShortcutPicker')) picker.open = false; });
document.addEventListener('click', event => { for (const menu of document.querySelectorAll('.session-item-menu[open]')) if (!menu.contains(event.target)) menu.open = false; });
window.addEventListener('pagehide', suspendSessionWorkspace);

$('#sessionBrowserArchived').addEventListener('change', event => {
 if (!conversationView) return;
 const view=conversationView;
 view.requestedSession=null;
 conversationSelection++;closeSessionHistory(false);
 view.archived=event.target.checked;view.selected=undefined;view.sessions=[];view.creating=false;view.checkedAt=0;
 view.requestID=(view.requestID||0)+1;view.requestKey=null;view.loading=false;
 rememberConversationView();renderConversationBrowser();refreshSessionWorkspace(true);showConversationSelection();
});
window.addEventListener('workhub:session-managed', event => {
  const {session: raw, action, environment} = event.detail;
  const session = conversationTaggedSession(raw, environment);
  const load = conversationShortcutLoads.get(environment);
  if (load) { load.revision++; load.loading = false; load.checkedAt = 0; }
  const index = conversationIndex.get(environment) || new Map();
  index.set(session.id, {...index.get(session.id), ...session});
  conversationIndex.set(environment, index);
  for (const view of conversationViews.values()) {
    view.sessions = view.sessions.map(s => conversationSessionKey(s) === conversationSessionKey(session) ? {...s, ...session} : s);
    if (action === 'archive' || action === 'restore') view.sessions = view.sessions.filter(s => !!s.archived === !!view.archived);
    view.checkedAt = 0; view.requestID = (view.requestID || 0) + 1; view.requestKey = null; view.loading = false;
  }
  if (sessionHistoryState?.environment === environment && sessionHistoryState?.session === session.id) window.WorkHubAssistant?.updateSession?.(index.get(session.id));
  updateConversationNavigation();
  const view = conversationView;
  if (!view || !conversationVisible()) return;
  if (action === 'fork' && sessionHistoryState?.environment === environment) {
    view.archived = false;
    view.search = ''; view.statusFilter = 'all';
    view.sessions.unshift(session); view.selected = conversationSessionKey(session); view.creating = false; view.pane = 'detail';
    closeSessionHistory(false); showConversationSelection();
  } else if ((action === 'archive' || action === 'restore') && view.selected === conversationSessionKey(session)) {
    view.selected = view.sessions[0] ? conversationSessionKey(view.sessions[0]) : undefined;
    closeSessionHistory(false); showConversationSelection();
  }
  renderConversationBrowser(); rememberConversationView();
});

function browserCreationTarget(directory) {
  const target = {...directory.target};
  if (target.task_id) target.additional_directories = conversationDirectories(conversationView.scope).filter(d => d.environment === directory.environment && !d.disabled && d.target?.project_id && conversationPathKey(d.cwd) !== conversationPathKey(target.cwd)).map(d => d.cwd);
  return target;
}
$('#sessionBrowserAdditionalDirectories').addEventListener('change', event => {
  if (!event.target.matches('[data-additional-directory]') || !conversationView?.creating || !conversationView.target) return;
  conversationView.target = {...conversationView.target, additional_directories: [...$('#sessionBrowserAdditionalDirectories').querySelectorAll('input:checked')].map(input => input.dataset.additionalDirectory)};
  conversationSelection++; closeSessionHistory(false); renderConversationBrowser(); showConversationSelection();
});
window.addEventListener('workhub:task-sessions', event => {
  const {task, environment} = event.detail;
  for (const view of conversationViews.values()) {
  if (conversationScopeEnvironment(view.scope) !== environment || view.scope.kind !== 'task' || view.scope.id !== task) continue;
    view.checkedAt = 0; view.requestID = (view.requestID || 0) + 1; view.loading = false;
  }
  if (conversationView?.scope.kind === 'task' && conversationScopeEnvironment(conversationView.scope) === environment && conversationView.scope.id === task) refreshSessionWorkspace(true);
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-conversation-unlink]');
  if (!button || state.busy) return;
  const environment = button.dataset.environment || activeEnvironment, task = button.dataset.task, session = button.dataset.conversationUnlink;
  mutation('正在取消会话关联', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(task)}/sessions/${encodeURIComponent(session)}`, {environment, method: 'DELETE'});
    window.dispatchEvent(new CustomEvent('workhub:task-sessions', {detail:{task, environment}}));
    toast(result.message);
  });
});
