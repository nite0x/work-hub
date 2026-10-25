'use strict';

// One mounted browser moves between the standalone page and the native modal.
// Only the view's scope changes; session controllers remain keyed by environment
// and session ID, so drafts, attachments and reading position are shared.
const conversationViews = new Map();
const conversationIndex = new Map();
const conversationPageScopes = new Map();
const conversationRecent = new Map();
const conversationShortcutLoads = new Map();
const conversationPinRequests = new Set();
let conversationView = null;
let conversationMode = 'hidden';
let conversationOrigin = '';
let conversationTrigger = null;
let conversationMoving = false;
let conversationSelection = 0;
const conversationHost = $('#sessionBrowser');
const conversationDialog = $('#conversationDialog');

// The same split survives transfers between the page and the conversation dialog.
function setupConversationResize() {
  const handle = $('#sessionBrowserResize');
  const list = $('#sessionBrowserListPane');
  const body = conversationHost.querySelector('.session-browser-body');
  const storageKey = 'workhub:conversation-list-width:v1';
  let drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 220 && saved <= 520) conversationHost.style.setProperty('--conversation-list-width', saved + 'px');
  } catch { /* Storage is optional. */ }
  function limits() {
    const width = body.getBoundingClientRect().width;
    return width > 620 ? { min: 220, max: Math.min(520, width - 328) } : null;
  }
  function sync() {
    const bounds = limits();
    if (!bounds) return;
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(list.getBoundingClientRect().width)));
  }
  function resize(width) {
    const bounds = limits();
    if (!bounds) return;
    const next = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
    conversationHost.style.setProperty('--conversation-list-width', next + 'px');
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(next));
  }
  function remember() {
    try { localStorage.setItem(storageKey, parseFloat(conversationHost.style.getPropertyValue('--conversation-list-width'))); } catch { /* Keep the in-memory size. */ }
  }
  function finish(event) {
    if (!drag || event?.pointerId != null && event.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    delete conversationHost.dataset.resizing;
    if (handle.hasPointerCapture?.(current.id)) handle.releasePointerCapture(current.id);
    if (current.moved) remember();
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !limits()) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: list.getBoundingClientRect().width, moved: false };
    conversationHost.dataset.resizing = '';
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!limits()) { finish(event); return; }
    drag.moved = true;
    resize(drag.width + event.clientX - drag.x);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
  handle.addEventListener('keydown', event => {
    const bounds = limits();
    if (!bounds || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = list.getBoundingClientRect().width;
    resize(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
    remember();
  });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { if (drag && !limits()) finish(); sync(); });
    observer.observe(body);
    observer.observe(list);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  window.addEventListener('resize', sync);
  window.addEventListener('blur', () => finish());
  window.addEventListener('pagehide', () => finish());
}
setupConversationResize();

const conversationPathKey = path => {
  let value = String(path || '').replace(/\\/g, '/');
  if (value !== '/') value = value.replace(/\/+$/, '');
  if (/^[a-z]:/i.test(value) || value.startsWith('//')) value = value.toLowerCase();
  return value;
};
const conversationScopeKey = (scope, environment = activeEnvironment) => JSON.stringify([environment, scope.kind, scope.id || '', scope.cwd || '']);
function conversationVisible() { return conversationMode !== 'hidden' && !conversationHost.hidden; }
function conversationReadingSession(id) {
  const width = conversationHost.getBoundingClientRect().width;
  return !document.hidden && conversationVisible() && !conversationView?.creating && conversationView?.selected === id && (conversationView.pane === 'detail' || !width || width > 620);
}
function conversationItems(environment = activeEnvironment) { return [...(conversationIndex.get(environment)?.values() || [])]; }
function recentConversationIDs(environment = activeEnvironment) {
  if (!conversationRecent.has(environment)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('workhub:recent-conversations:v1:' + environment)); } catch { /* Storage is optional. */ }
    conversationRecent.set(environment, Array.isArray(saved) ? [...new Set(saved.filter(id => typeof id === 'string'))].slice(0, 50) : []);
  }
  return conversationRecent.get(environment);
}
function rememberOpenedConversation(session) {
  if (!session || !conversationReadingSession(session.id)) return;
  const ids = recentConversationIDs();
  if (ids[0] === session.id) return;
  const next = [session.id, ...ids.filter(id => id !== session.id)].slice(0, 50);
  conversationRecent.set(activeEnvironment, next);
  try { localStorage.setItem('workhub:recent-conversations:v1:' + activeEnvironment, JSON.stringify(next)); } catch { /* Keep memory fallback. */ }
  renderConversationShortcuts();
}
function renderConversationShortcuts() {
  if (!window.document) return;
  const host = $('#conversationShortcuts');
  const items = conversationItems().filter(s => !s.archived);
  const byID = new Map(items.map(s => [s.id, s]));
  const enrich = s => ({...sessionWithUnread(s), context: window.WorkHubUI.conversationContext(s.cwd, {tasks: state.requirements, projects: state.projects})});
  const load = conversationShortcutLoads.get(activeEnvironment);
  const markup = window.WorkHubUI.conversationShortcuts({
    pinned: items.filter(s => s.pinned).sort((a,b) => a.id.localeCompare(b.id)).map(enrich),
    recent: recentConversationIDs().map(id => byID.get(id)).filter(s => s && !s.pinned).slice(0, 5).map(enrich),
    selected: conversationVisible() && conversationView?.environment === activeEnvironment && !conversationView.creating ? conversationView.selected : null,
    loading: load?.loading, error: load?.error, readOnly: sessionReadOnly,
  });
  if (host.dataset.markup !== markup) {
    const expanded = host.querySelector('.conversation-shortcuts-more')?.open;
    const focused = host.contains(document.activeElement) ? {id: document.activeElement.dataset.conversationShortcut || document.activeElement.dataset.shortcutPin, pin: !!document.activeElement.dataset.shortcutPin} : null;
    const top = host.scrollTop;
    host.innerHTML = markup; host.dataset.markup = markup;
    if (expanded && host.querySelector('.conversation-shortcuts-more')) host.querySelector('.conversation-shortcuts-more').open = true;
    host.scrollTop = top;
    if (focused) [...host.querySelectorAll(focused.pin ? '[data-shortcut-pin]' : '[data-conversation-shortcut]')].find(b => (focused.pin ? b.dataset.shortcutPin : b.dataset.conversationShortcut) === focused.id)?.focus({preventScroll:true});
  }
  for (const button of host.querySelectorAll('[data-shortcut-pin]')) button.disabled = conversationPinRequests.has(JSON.stringify([activeEnvironment, button.dataset.shortcutPin]));
}
function refreshConversationShortcuts(force = false) {
  const environment = activeEnvironment;
  let load = conversationShortcutLoads.get(environment);
  if (!load) { load = {loading:false, checkedAt:0, revision:0, error:''}; conversationShortcutLoads.set(environment, load); }
  if (load.loading) return load.pending;
  if (!force && Date.now() - load.checkedAt < 10000) return;
  load.loading = true; load.checkedAt = Date.now();
  const revision = load.revision;
  renderConversationShortcuts();
  load.pending = (async () => {
    try {
      const result = await api('/api/sessions?', {environment});
      if (environment !== activeEnvironment || load.revision !== revision) return;
      conversationIndex.set(environment, new Map((result.sessions || []).map(s => [s.id, s])));
      load.error = result.error || '';
    } catch (error) {
      if (environment === activeEnvironment && load.revision === revision) load.error = error.message;
    } finally {
      if (load.revision === revision) {
        load.loading = false;
        if (environment === activeEnvironment) updateConversationNavigation();
      }
    }
  })();
  return load.pending;
}
function openConversationShortcut(id) {
  if (state.busy || !conversationItems().some(s => s.id === id && !s.archived)) return;
  rememberConversationView();
  const scope = {kind:'all', name:'全部会话'};
  const view = conversationViewFor(scope);
  Object.assign(view, {directory:'', search:'', archived:false, selected:id, requestedSession:id, creating:false, target:null, pane:'detail', sessions:conversationItems().filter(s => !s.archived)});
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
async function toggleConversationShortcutPin(id) {
  const environment = activeEnvironment;
  const session = conversationItems().find(s => s.id === id);
  const key = JSON.stringify([environment, id]);
  if (!session || sessionReadOnly || state.busy || conversationPinRequests.has(key)) return;
  const action = session.pinned ? 'unpin' : 'pin';
  conversationPinRequests.add(key); renderConversationShortcuts();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/manage`, {environment, method:'POST', body:JSON.stringify({action})});
    window.dispatchEvent(new CustomEvent('workhub:session-managed', {detail:{session:result.session, action, environment}}));
  } catch (error) { if (environment === activeEnvironment) toast(error.message, true); }
  finally { conversationPinRequests.delete(key); if (environment === activeEnvironment) renderConversationShortcuts(); }
}
function conversationViewFor(scope) {
  const key = conversationScopeKey(scope);
  if (!conversationViews.has(key)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('workhub:conversation-view:v1:' + key)); } catch { /* Storage is optional. */ }
    conversationViews.set(key, { key, environment: activeEnvironment, scope, directory: typeof saved?.directory === 'string' ? saved.directory : '', selected: typeof saved?.selected === 'string' ? saved.selected : undefined, archived: !!saved?.archived, search: '', pane: 'list', sessions: [], loading: false, error: '', checkedAt: 0, scrollTop: 0, creating: false });
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
function conversationDirectories(scope = conversationView?.scope) {
  if (!scope) return [];
  const result = [];
  const add = (cwd, label, target, disabled = false) => {
    if (!cwd) return;
    const key = conversationPathKey(cwd);
    const existing = result.find(d => conversationPathKey(d.cwd) === key);
    if (!existing) result.push({ cwd, label, target, disabled });
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
  if (scope.kind === 'task') {
    const task = state.requirements.find(q => q.id === scope.id);
    if (task) taskDirs(task);
    for (const session of conversationView?.scope.id === scope.id ? conversationView.sessions : []) add(session.cwd, session.cwd, null, true);
  } else if (scope.kind === 'project') {
    const project = state.projects.find(p => p.id === scope.id);
    if (project) projectDirs(project);
  } else {
    state.projects.forEach(projectDirs);
    state.requirements.forEach(taskDirs);
    for (const session of conversationItems()) add(session.cwd, session.cwd, null, true);
    if (scope.kind === 'directory') {
      const matching = result.filter(d => conversationPathKey(d.cwd) === conversationPathKey(scope.cwd));
      return matching.length ? matching : [{ cwd: scope.cwd, label: scope.cwd, target: null, disabled: true }];
    }
  }
  return result;
}
function conversationFilteredDirectories(view = conversationView) {
  const dirs = conversationDirectories(view.scope);
  return view.directory ? dirs.filter(d => conversationPathKey(d.cwd) === conversationPathKey(view.directory)) : dirs;
}
function conversationScopeName(scope) {
  if (scope.kind === 'all') return '全部会话';
  if (scope.kind === 'task') return '任务 · ' + (state.requirements.find(q => q.id === scope.id)?.name || scope.name || scope.id);
  if (scope.kind === 'project') return '项目 · ' + (state.projects.find(p => p.id === scope.id)?.name || scope.name || scope.id);
  return '目录 · ' + scope.cwd;
}
function renderConversationScopes() {
  const scopes = [{ kind: 'all', name: '全部会话' }, ...state.requirements.map(q => ({ kind: 'task', id: q.id, name: q.name })), ...state.projects.map(p => ({ kind: 'project', id: p.id, name: p.name })), ...conversationDirectories({ kind: 'all' }).map(d => ({ kind: 'directory', cwd: d.cwd, name: d.cwd }))];
  const search = $('#sessionScopeSearch').value.trim().toLowerCase();
  const matching = scopes.filter(s => !search || [s.name, s.cwd].join(' ').toLowerCase().includes(search));
  $('#sessionScopeOptions').innerHTML = matching.length ? window.WorkHubUI.conversationScopes(matching) : '<p class="session-empty">没有匹配的范围</p>';
}
function updateConversationNavigation() {
  if (!window.document) return;
  const items = conversationItems().filter(s => !s.archived);
  const waiting = items.filter(s => s.chat_status === 'waiting').length;
  const running = items.filter(s => s.chat_status && s.chat_status !== 'waiting').length;
  const unread = items.filter(s => sessionWithUnread(s).unread).length;
  const text = waiting ? '待确认' : running ? '运行中' : unread ? '有新消息' : '';
  const node = $('#sessionNavigationStatus');
  node.textContent = text; node.hidden = !text;
  node.setAttribute('aria-label', waiting ? `${waiting} 个会话待确认` : running ? `${running} 个会话运行中` : `${unread} 个会话有新消息`);
  renderConversationShortcuts();
}
function renderConversationList() {
  const view = conversationView;
  if (!view || view.environment !== activeEnvironment) return;
  const text = view.search.trim().toLowerCase();
  const sessions = view.sessions.map(s => ({...sessionWithUnread(s), context: window.WorkHubUI.conversationContext(s.cwd, {tasks: state.requirements, projects: state.projects}, view.scope.kind === 'task' ? view.scope.id : undefined)})).filter(s => !text || [s.name, s.cwd, s.context.project, s.context.branch, ...s.context.tasks.map(t => t.name)].join(' ').toLowerCase().includes(text)).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || (b.updated_at||0)-(a.updated_at||0));
  const markup = window.WorkHubUI.conversationList({ sessions, selected: view.creating ? null : view.selected, showDirectory: !view.directory && view.scope.kind !== 'directory', loading: view.loading, taskID: view.scope.kind === 'task' ? view.scope.id : undefined });
  const list = $('#sessionBrowserList');
  if (list.innerHTML !== markup) {
    const top = list.scrollTop;
    const selected = list.contains(document.activeElement) ? document.activeElement?.dataset.conversationSession : null;
    list.innerHTML = markup;
    list.scrollTop = top;
    if (selected) [...list.querySelectorAll('[data-conversation-session]')].find(b => b.dataset.conversationSession === selected)?.focus({ preventScroll: true });
  }
  const running = sessions.filter(s => ['starting','running','stopping','handoff'].includes(s.chat_status)).length;
  const waiting = sessions.filter(s => s.chat_status === 'waiting').length;
  $('#sessionBrowserCount').textContent = `${sessions.length} 个对话${running ? ` · ${running} 个运行中` : ''}${waiting ? ` · ${waiting} 个待确认` : ''}${view.loading ? ' · 更新中' : ''}`;
  $('#sessionBrowserError').hidden = !view.error;
  $('#sessionBrowserError').textContent = view.error;
  updateConversationNavigation();
}
function renderConversationBrowser() {
  const view = conversationView;
  if (!view) return;
  window.WorkHubAssistant?.updateWorkspace?.({tasks: state.requirements, projects: state.projects});
  conversationHost.hidden = conversationMode === 'hidden';
  conversationHost.dataset.pane = view.pane;
  $('#sessionBrowserScopeBar').hidden = conversationMode !== 'page';
  $('#sessionScopeLabel').textContent = conversationScopeName(view.scope);
  $('#sessionBrowserContext').textContent = conversationScopeName(view.scope) + ' · ' + environmentName(activeEnvironment);
  $('#sessionScopeAll').hidden = view.scope.kind === 'all';
  $('#conversationDialogTitle').textContent = conversationScopeName(view.scope) + ' · 对话';
  const dirs = conversationDirectories();
  const missingDirectory = view.directory && !dirs.some(d => conversationPathKey(d.cwd) === conversationPathKey(view.directory));
  $('#taskConversationTools').hidden = view.scope.kind !== 'task';
  $('#linkTaskConversation').dataset.requirement = view.scope.kind === 'task' ? view.scope.id : '';
  $('#conversationDialogScope').textContent = view.scope.kind === 'task' ? '与这项工作明确关联的会话 · 独立保存和运行' : view.scope.kind === 'project' ? `项目下的 ${dirs.length} 个工作目录` : view.scope.cwd || '全部工作目录';
  $('#sessionDirectoryField').hidden = (!view.directory && dirs.length < 2) || view.scope.kind === 'directory';
  const filter = $('#sessionDirectoryFilter');
  const options = '<option value="">全部目录</option>' + dirs.map(d => `<option value="${esc(d.cwd)}">${esc(d.label)} · ${esc(d.cwd)}</option>`).join('') + (missingDirectory ? `<option value="${esc(view.directory)}">目录待核实 · ${esc(view.directory)}</option>` : '');
  if (filter.innerHTML !== options) filter.innerHTML = options;
  filter.value = view.directory;
  $('#sessionBrowserSearch').value = view.search;
  $('#sessionBrowserArchived').checked = !!view.archived;
  const filterCount = Number(!!view.directory) + Number(!!view.archived);
  $('#sessionFilterCount').textContent = String(filterCount);
  $('#sessionFilterCount').hidden = !filterCount;
  $('#sessionClearFilters').hidden = !filterCount;
  $('#sessionFilterPicker').classList.toggle('has-filters', !!filterCount);
  $('#sessionFilterPicker').querySelector('summary').title = [view.directory, view.archived ? '已归档对话' : ''].filter(Boolean).join(' · ') || '筛选目录与归档';
  $('#sessionActiveFilterLabel').hidden = !filterCount;
  $('#sessionActiveFilterLabel').textContent = [view.directory ? view.directory.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || view.directory : '', view.archived ? '已归档' : ''].filter(Boolean).join(' · ');
  $('#sessionActiveFilterLabel').title = view.directory;
  const available = conversationFilteredDirectories().filter(d => !d.disabled && d.target);
  $('#newBrowserSession').disabled = sessionReadOnly || !available.length;
  $('#newBrowserSession').title = sessionReadOnly ? '当前为只读模式，请在终端新建对话' : !available.length ? '当前范围没有可用于新建对话的工作目录' : '';
  $('#sessionBrowserNewDirectoryField').hidden = !view.creating || available.length < 2;
  if (view.creating) {
    $('#sessionBrowserNewDirectory').innerHTML = '<option value="">请选择工作目录</option>' + available.map(d => `<option value="${esc(d.cwd)}">${esc(d.label)} · ${esc(d.cwd)}</option>`).join('');
    $('#sessionBrowserNewDirectory').value = view.target?.cwd || '';
  }
  const extraField = $('#sessionBrowserAdditionalField');
  const extraDirs = view.creating && view.target?.task_id ? available.filter(d => d.target?.project_id && d.cwd !== view.target.cwd) : [];
  extraField.hidden = !extraDirs.length;
  if (extraDirs.length) {
    const markup = extraDirs.map(d => `<label class="task-additional-directory"><input type="checkbox" data-additional-directory="${esc(d.cwd)}" ${view.target.additional_directories?.includes(d.cwd) ? 'checked' : ''} />${esc(d.label)}<small>${esc(d.cwd)}</small></label>`).join('');
    if ($('#sessionBrowserAdditionalDirectories').innerHTML !== markup) $('#sessionBrowserAdditionalDirectories').innerHTML = markup;
  }
  renderConversationList();
}
async function refreshSessionWorkspace(force = false) {
  const shortcuts = refreshConversationShortcuts(force);
  const visible = conversationVisible();
  if (!visible) return shortcuts;
  const view = visible ? conversationView : null;
  if (!view || view.environment !== activeEnvironment || view.loading || !force && Date.now() - view.checkedAt < 10000) return;
  const environment = activeEnvironment;
  const directory = view.directory;
  const requestKey = JSON.stringify([view.scope, directory, !!view.archived]);
  const requestID = (view.requestID || 0) + 1;
  view.requestID = requestID;
  const params = new URLSearchParams();
  if (view.archived) params.set("archived","true");
  if (view.scope.kind === 'task') { params.set('task_id', view.scope.id); params.set('linked', 'true'); }
  if (view.scope.kind === 'project') params.set('project_id', view.scope.id);
  const cwd = directory || (view.scope.kind === 'directory' ? view.scope.cwd : '');
  if (cwd) params.set('cwd', cwd);
  view.loading = true; view.error = ''; view.requestKey = requestKey; view.checkedAt = Date.now();
  if (visible) renderConversationList();
  try {
    const result = await api('/api/sessions?' + params, { environment });
    if (view.requestID !== requestID || view.requestKey !== requestKey || environment !== activeEnvironment || view.directory !== directory) return;
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    let index = conversationIndex.get(environment) || new Map();
    if (view.scope.kind === 'all' && !directory && !view.archived) index = new Map();
    for (const s of sessions) index.set(s.id, s);
    conversationIndex.set(environment, index);
    view.sessions = sessions;
    view.error = result.error || '';
    if (view.requestedSession) {
      if (sessions.some(s => s.id === view.requestedSession)) view.requestedSession = null;
      else view.error = view.error || '该对话暂不可用，请刷新列表重试。';
    } else if (!view.creating && !sessions.some(s => s.id === view.selected)) view.selected = sessions[0]?.id;
    if (view === conversationView && conversationVisible()) {
      renderConversationBrowser();
      if (!view.creating) showConversationSelection();
    }
    updateConversationNavigation();
  } catch (error) {
    if (environment !== activeEnvironment || view.requestID !== requestID || view.requestKey !== requestKey || view.directory !== directory) return;
    view.error = error.message;
  } finally {
    if (view.requestID === requestID && view.requestKey === requestKey) view.loading = false;
    if (view === conversationView && conversationVisible()) {
      renderConversationList();
      if (!view.creating && !view.selected) showConversationSelection();
    }
  }
}
function showConversationSelection() {
  const view = conversationView;
  if (!view || !conversationVisible()) return;
  const session = view.creating ? null : view.sessions.find(s => s.id === view.selected);
  if (view.creating && !view.target || !view.creating && !session) {
    closeSessionHistory(false);
    $('#sessionBrowserEmpty').hidden = false;
    $('#sessionBrowserEmpty').textContent = view.creating ? '选择本次对话的工作目录。' : view.loading ? '正在读取对话…' : view.error ? '暂时无法读取对话，请点击列表中的刷新重试。' : '这里还没有对话，可以从列表上方新建。';
    return;
  }
  const targetKey = JSON.stringify(view.target || null);
  if (session && conversationReadingSession(session.id)) saveSessionRead(session);
  rememberOpenedConversation(session);
  if (sessionHistoryState?.environment === activeEnvironment && (session ? sessionHistoryState.session === session.id : !sessionHistoryState.session && sessionHistoryState.browserTarget === targetKey)) {
    if (session) window.WorkHubAssistant?.updateSession?.(session);
    return;
  }
  $('#sessionBrowserEmpty').hidden = true;
  const selection = ++conversationSelection;
  const environment = activeEnvironment;
  openSessionHistoryPanel(view.scope.kind === 'task' ? view.scope.id : null, session?.id || null, {
    session, target: view.target, browserTarget: targetKey,
    created(created) {
      const index = conversationIndex.get(environment) || new Map();
      index.set(created.id, created); conversationIndex.set(environment, index);
      if (!view.sessions.some(s => s.id === created.id)) view.sessions.unshift(created);
      if (environment !== activeEnvironment || conversationView !== view || selection !== conversationSelection) return;
      view.selected = created.id; view.creating = false; view.target = null;
      rememberOpenedConversation(created);
      renderConversationBrowser(); rememberConversationView();
    }
  });
  renderConversationList();
}
function selectConversationScope(scope) {
  rememberConversationView();
  conversationSelection++;
  closeSessionHistory(false);
  conversationView = conversationViewFor(scope);
  $('#sessionScopePicker').open = false;
  $('#sessionScopeSearch').value = '';
  $('#sessionFilterPicker').open = false;
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
    const cached = conversationItems().find(s => s.id === session) || requirementSessions.get(scope.id)?.sessions.find(s => s.id === session);
    if (cached && !conversationView.sessions.some(s => s.id === session)) conversationView.sessions.unshift(cached);
    conversationView.selected = session;
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
  closeConversationWorkspace(false);
  const load = conversationShortcutLoads.get(activeEnvironment);
  if (load) { load.revision++; load.loading = false; load.checkedAt = 0; }
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
  conversationSelection++;
  closeSessionHistory(false);
  renderConversationBrowser(); showConversationSelection();
  ($('#sessionBrowserNewDirectoryField').hidden ? $('#assistantChatRoot textarea') : $('#sessionBrowserNewDirectory'))?.focus();
}
function browserSessionActivity(id, chat) {
  const item = conversationIndex.get(activeEnvironment)?.get(id);
  if (item) { item.chat_status = chat.busy ? chat.status : ''; if (!chat.busy && chat.turn_id) item.completed_run = chat.id; }
  for (const view of conversationViews.values()) {
    if (view.environment !== activeEnvironment) continue;
    const s = view.sessions.find(s => s.id === id);
    if (s) { s.chat_status = chat.busy ? chat.status : ''; if (!chat.busy && chat.turn_id) s.completed_run = chat.id; }
  }
  if (conversationVisible()) renderConversationList(); else updateConversationNavigation();
}
document.addEventListener('click', event => {
  const shortcut = event.target.closest('[data-conversation-shortcut]');
  if (shortcut) return openConversationShortcut(shortcut.dataset.conversationShortcut);
  const pin = event.target.closest('[data-shortcut-pin]');
  if (pin && !pin.disabled) return toggleConversationShortcutPin(pin.dataset.shortcutPin);
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
  const button = event.target.closest('[data-conversation-action]');
  if (!button || button.disabled || state.busy) return;
  switch (button.dataset.conversationAction) {
    case 'new': startBrowserConversation(); break;
    case 'close': closeConversationWorkspace(); break;
    case 'refresh': refreshSessionWorkspace(true); break;
    case 'refresh-shortcuts': refreshConversationShortcuts(true); break;
    case 'clear-filters':
      conversationView.archived = false; $('#sessionBrowserArchived').checked = false;
      $('#sessionDirectoryFilter').value = '';
      $('#sessionDirectoryFilter').dispatchEvent(new Event('change', {bubbles:true}));
      $('#sessionFilterPicker').open = false;
      break;
    case 'all': selectConversationScope({ kind: 'all', name: '全部会话' }); rememberConversationView(); break;
    case 'back': conversationView.pane = 'list'; renderConversationBrowser(); break;
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
$('#sessionBrowserSearch').addEventListener('input', event => { if (conversationView) { conversationView.search = event.target.value; renderConversationList(); } });
$('#sessionScopeSearch').addEventListener('input', renderConversationScopes);
$('#sessionScopePicker').addEventListener('toggle', () => { if ($('#sessionScopePicker').open) { renderConversationScopes(); $('#sessionScopeSearch').focus(); } });
$('#sessionBrowserNewDirectory').addEventListener('change', event => {
  if (!conversationView?.creating) return;
  const directory = conversationFilteredDirectories().find(d => conversationPathKey(d.cwd) === conversationPathKey(event.target.value));
  conversationView.target = directory ? browserCreationTarget(directory) : null;
  conversationSelection++; closeSessionHistory(false); renderConversationBrowser(); showConversationSelection();
});
conversationDialog.addEventListener('close', () => { if (!conversationMoving && conversationMode === 'modal') closeConversationWorkspace(); });
conversationDialog.addEventListener('cancel', event => { event.preventDefault(); if (!state.busy) closeConversationWorkspace(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#sessionFilterPicker').open) { $('#sessionFilterPicker').open = false; $('#sessionFilterPicker summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
  if (event.key === 'Escape' && $('#sessionScopePicker').open) { $('#sessionScopePicker').open = false; event.preventDefault(); event.stopPropagation(); }
}, true);
document.addEventListener('click', event => { if (!event.target.closest('#sessionScopePicker')) $('#sessionScopePicker').open = false; });
document.addEventListener('click', event => { if (!event.target.closest('#sessionFilterPicker')) $('#sessionFilterPicker').open = false; });
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
window.addEventListener('workhub:session-managed',event=>{
 const {session,action,environment}=event.detail;
 const load=conversationShortcutLoads.get(environment);
 if(load){load.revision++;load.loading=false;load.checkedAt=0;}
 const index=conversationIndex.get(environment)||new Map();
 index.set(session.id,{...index.get(session.id),...session});conversationIndex.set(environment,index);
 for(const view of conversationViews.values()){
  if(view.environment!==environment)continue;
  view.sessions=view.sessions.map(s=>s.id===session.id?{...s,...session}:s);
  if(action==='archive'||action==='restore')view.sessions=view.sessions.filter(s=>!!s.archived===!!view.archived);
  view.checkedAt=0;view.requestID=(view.requestID||0)+1;view.requestKey=null;view.loading=false;
 }
 if(environment===activeEnvironment){
   if(sessionHistoryState?.environment===environment && sessionHistoryState?.session===session.id) window.WorkHubAssistant?.updateSession?.(index.get(session.id));
   updateConversationNavigation();
 }
 if(environment!==activeEnvironment || !conversationView)return;
 if(action==='fork'){
  conversationView.archived=false;
  conversationView.sessions.unshift(session);conversationView.selected=session.id;conversationView.creating=false;conversationView.pane='detail';
  closeSessionHistory(false);showConversationSelection();
 }else if(action==='archive'||action==='restore'){
  conversationView.selected=conversationView.sessions[0]?.id;
  closeSessionHistory(false);showConversationSelection();
 }
 renderConversationBrowser();rememberConversationView();
});

function browserCreationTarget(directory) {
  const target = {...directory.target};
  if (target.task_id) target.additional_directories = conversationDirectories(conversationView.scope).filter(d => !d.disabled && d.target?.project_id && conversationPathKey(d.cwd) !== conversationPathKey(target.cwd)).map(d => d.cwd);
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
    if (view.environment !== environment || view.scope.kind !== 'task' || view.scope.id !== task) continue;
    view.checkedAt = 0; view.requestID = (view.requestID || 0) + 1; view.loading = false;
  }
  if (environment === activeEnvironment && conversationView?.scope.kind === 'task' && conversationView.scope.id === task) refreshSessionWorkspace(true);
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-conversation-unlink]');
  if (!button || state.busy) return;
  const environment = activeEnvironment, task = button.dataset.task, session = button.dataset.conversationUnlink;
  mutation('正在取消会话关联', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(task)}/sessions/${encodeURIComponent(session)}`, {environment, method: 'DELETE'});
    window.dispatchEvent(new CustomEvent('workhub:task-sessions', {detail:{task, environment}}));
    toast(result.message);
  });
});
