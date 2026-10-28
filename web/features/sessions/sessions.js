'use strict';
const requirementSessions = new Map();
let sessionPickerRequirement = null;
let sessionPickerEnvironment = null;
let sessionPickerCursor = null;
let sessionPickerLoading = false;
let sessionPickerGeneration = 0;
let sessionPickerSearch = '';
let sessionPickerItems = [];
const sessionReadMemory = new Map();
function sessionReadKey(session, environment = activeEnvironment) { return 'workhub:session-read:' + JSON.stringify([environment, session]); }
function sessionReadProgress(session) {
  const key = sessionReadKey(session.id, session.environment_id || activeEnvironment);
  if (sessionReadMemory.has(key)) return sessionReadMemory.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Number.isFinite(saved.time)) { sessionReadMemory.set(key, saved); return saved; }
  } catch { /* Reading remains usable when browser storage is unavailable. */ }
  return saveSessionRead(session);
}
function saveSessionRead(session) {
  const key = sessionReadKey(session.id, session.environment_id || activeEnvironment);
  const saved = { time: Math.max(Date.now() / 1000, session.updated_at || 0), run: session.completed_run || '' };
  sessionReadMemory.set(key, saved);
  try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Keep an in-memory fallback. */ }
  return saved;
}
function sessionWithUnread(session) {
  const seen = sessionReadProgress(session);
  const open = typeof sessionHistoryState !== 'undefined' && sessionHistoryState?.session === session.id && (!sessionHistoryState.environment || sessionHistoryState.environment === (session.environment_id || activeEnvironment)) && !document.hidden && (typeof conversationReadingSession === 'function' ? conversationReadingSession(session.id, session.environment_id || activeEnvironment) : !document.getElementById('taskConversation')?.hidden);
  if (open) saveSessionRead(session);
  return { ...session, unread: !open && ((session.updated_at || 0) > seen.time || !!session.completed_run && session.completed_run !== seen.run) };
}
function markSessionRead(requirement, session) {
  const item = requirementSessions.get(requirement)?.sessions.find(s => s.id === session);
  if (item) { saveSessionRead(item); updateRequirementSessionsView(requirement); }
}
function updateSessionChatActivity(requirement, session, chat, environment = activeEnvironment) {
  if (typeof browserSessionActivity === 'function') browserSessionActivity(session, chat, environment);
  if (environment !== activeEnvironment) return;
  // Every task sharing this directory observes the same session activity.
  for (const [id, data] of requirementSessions) {
    const item = data.sessions.find(s => s.id === session);
    if (!item) continue;
    const status = chat.busy ? chat.status : '';
    const completed = !chat.busy && chat.turn_id ? chat.id : item.completed_run;
    if (item.chat_status === status && item.completed_run === completed) continue;
    item.chat_status = status;
    item.completed_run = completed;
    updateRequirementSessionsView(id);
  }
}

function sessionTime(value) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '暂无活动记录';
}

function renderRequirementSessions(q) {
  const data = requirementSessions.get(q.id);
  return window.WorkHubUI.sessions(q, data && { ...data, sessions: data.sessions.map(sessionWithUnread) }, typeof sessionReadOnly !== 'undefined' && sessionReadOnly);
}

function updateRequirementSessionsView(id) {
  if (state.selectedRequirement !== id || state.view !== 'requirements') return;
  const q = state.requirements.find(q => q.id === id);
  const container = $('#requirementSessions');
  if (q && container) {
    const view = $('#taskSessionsView');
    const top = view?.scrollTop || 0;
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusSession = focused?.dataset.session;
    const focusAction = focused?.dataset.sessionAction;
    const markup = renderRequirementSessions(q);
    if (container.outerHTML !== markup) {
      container.outerHTML = markup;
      const next = $('#requirementSessions');
      if (view) view.scrollTop = top;
      if (focused) {
        const target = [...next.querySelectorAll('[data-session-action]')].find(node => node.dataset.session === focusSession && node.dataset.sessionAction === focusAction);
        (target || next.querySelector('button'))?.focus({preventScroll: true});
      }
    }
  }
  if (typeof updateTaskConversationStatus === 'function') updateTaskConversationStatus();
}

async function refreshRequirementSessions(id, force = true) {
  const previous = requirementSessions.get(id);
  if (previous?.loading) return;
  if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < 10000) return;
  const data = { sessions: previous?.sessions || [], loading: true, error: '', checkedAt: Date.now() };
  requirementSessions.set(id, data);
  try {
    const result = await api(`/api/sessions?task_id=${encodeURIComponent(id)}&linked=true`);
    data.sessions = result.sessions;
    data.error = result.error || '';
  } catch (error) { data.error = error.message; }
  finally { data.loading = false; updateRequirementSessionsView(id); }
}

function renderSessionPicker() {
  const items = sessionPickerEnvironment === activeEnvironment ? requirementSessions.get(sessionPickerRequirement)?.sessions : typeof conversationView !== 'undefined' && conversationView?.scope.kind === 'task' && conversationView.scope.id === sessionPickerRequirement && conversationScopeEnvironment(conversationView.scope) === sessionPickerEnvironment ? conversationView.sessions : [];
  const linked = new Set((items || []).map(s => s.id));
  $('#sessionPickerResults').innerHTML = window.WorkHubUI.sessionPicker(sessionPickerItems, [...linked]);
  $('#sessionPickerMore').hidden = !sessionPickerCursor;
}

async function loadSessionPicker(more = false) {
  if (sessionPickerLoading) return;
  sessionPickerLoading = true;
  const generation = sessionPickerGeneration;
  $('#sessionPickerError').hidden = true;
  $('#sessionPickerMore').disabled = true;
  if (!more) { sessionPickerItems = []; $('#sessionPickerResults').textContent = '正在读取本地会话…'; }
  const params = new URLSearchParams();
  if (more && sessionPickerCursor) params.set('cursor', sessionPickerCursor);
  if (sessionPickerSearch) params.set('search', sessionPickerSearch);
  try {
    const [page, nearby] = await Promise.all([
      api('/api/codex/sessions?' + params, {environment:sessionPickerEnvironment}),
      !more && !sessionPickerSearch ? api('/api/sessions?task_id=' + encodeURIComponent(sessionPickerRequirement), {environment:sessionPickerEnvironment}).catch(() => ({sessions:[]})) : Promise.resolve({sessions:[]}),
    ]);
    if (generation !== sessionPickerGeneration) return;
    const byID = new Map((more ? sessionPickerItems : []).map(s => [s.id, s]));
    [...nearby.sessions, ...page.data].forEach(s => byID.set(s.id, s));
    const task = (typeof conversationWorkspace === 'function' ? conversationWorkspace(sessionPickerEnvironment) : state).requirements.find(q => q.id === sessionPickerRequirement);
    const paths = new Set(task ? [task.path,...task.members.map(m => m.path)] : []);
    sessionPickerItems = [...byID.values()].sort((a,b) => Number(paths.has(b.cwd))-Number(paths.has(a.cwd)));
    sessionPickerCursor = page.nextCursor;
    renderSessionPicker();
  } catch (error) {
    if (generation !== sessionPickerGeneration) return;
    $('#sessionPickerResults').textContent = '';
    $('#sessionPickerError').textContent = error.message;
    $('#sessionPickerError').hidden = false;
  } finally { sessionPickerLoading = false; $('#sessionPickerMore').disabled = false; }
}

async function linkPickedSession(id) {
  const requirement = sessionPickerRequirement;
  const environment = sessionPickerEnvironment;
  await mutation('正在关联会话', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(requirement)}/sessions`, { environment, method: 'POST', body: JSON.stringify({ session_id: id }) });
    if (environment === activeEnvironment) await refreshRequirementSessions(requirement);
    window.dispatchEvent(new CustomEvent('workhub:task-sessions', {detail:{task:requirement, environment}}));
    $('#sessionDialog').close();
    toast(result.message);
  }, $('#sessionPickerError'));
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-session-action]');
  if (!target || target.disabled || state.busy) return;
  const action = target.dataset.sessionAction;
  const id = target.dataset.requirement;
  if (action === 'refresh') return refreshRequirementSessions(id);
  if (action === 'picker') {
    if (sessionPickerLoading) return;
    sessionPickerRequirement = id;
    sessionPickerEnvironment = target.dataset.environment || activeEnvironment;
    if (sessionPickerEnvironment === activeEnvironment) refreshRequirementSessions(id).then(() => { if (sessionPickerRequirement === id && $('#sessionDialog').open) renderSessionPicker(); });
    sessionPickerGeneration++;
    sessionPickerCursor = null;
    sessionPickerSearch = '';
    $('#sessionSearchForm').reset(); $('#sessionLinkForm').reset();
    $('#sessionPickerMore').hidden = true;
    $('#sessionDialog').showModal();
    return loadSessionPicker();
  }
  if (action === 'link') return linkPickedSession(target.dataset.session);
  if (action === 'resume') return mutation('正在打开会话终端', async () => {
    const result = await api(`/api/sessions/${encodeURIComponent(target.dataset.session)}/resume`, { environment: sessionHistoryState?.environment || activeEnvironment, method: 'POST', body: '{}' });
    toast(result.message);
  });
});
$('#sessionSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  if (sessionPickerLoading) return;
  sessionPickerSearch = event.target.elements.search.value.trim();
  sessionPickerCursor = null;
  loadSessionPicker();
});
$('#sessionLinkForm').addEventListener('submit', event => {
  event.preventDefault(); linkPickedSession(event.target.elements.session_id.value.trim());
});
$('#sessionPickerMore').addEventListener('click', () => loadSessionPicker(true));
