'use strict';
const requirementSessions = new Map();
let sessionPickerRequirement = null;
let sessionPickerCursor = null;
let sessionPickerLoading = false;
let sessionPickerGeneration = 0;
let sessionPickerSearch = '';
let sessionPickerItems = [];
const sessionReadMemory = new Map();
function sessionReadKey(session) { return 'workhub:session-read:' + JSON.stringify([activeEnvironment, session]); }
function sessionReadProgress(session) {
  const key = sessionReadKey(session.id);
  if (sessionReadMemory.has(key)) return sessionReadMemory.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Number.isFinite(saved.time)) { sessionReadMemory.set(key, saved); return saved; }
  } catch { /* Reading remains usable when browser storage is unavailable. */ }
  return saveSessionRead(session);
}
function saveSessionRead(session) {
  const key = sessionReadKey(session.id);
  const saved = { time: Math.max(Date.now() / 1000, session.updated_at || 0), run: session.completed_run || '' };
  sessionReadMemory.set(key, saved);
  try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Keep an in-memory fallback. */ }
  return saved;
}
function sessionWithUnread(session) {
  const seen = sessionReadProgress(session);
  const open = typeof sessionHistoryState !== 'undefined' && sessionHistoryState?.session === session.id && !document.hidden;
  if (open) saveSessionRead(session);
  return { ...session, unread: !open && ((session.updated_at || 0) > seen.time || !!session.completed_run && session.completed_run !== seen.run) };
}
function markSessionRead(requirement, session) {
  const item = requirementSessions.get(requirement)?.sessions.find(s => s.id === session);
  if (item) { saveSessionRead(item); updateRequirementSessionsView(requirement); }
}
function updateSessionChatActivity(requirement, session, chat) {
  const item = requirementSessions.get(requirement)?.sessions.find(s => s.id === session);
  if (!item) return;
  const status = chat.busy ? chat.status : '';
  const completed = !chat.busy && chat.turn_id ? chat.id : item.completed_run;
  if (item.chat_status === status && item.completed_run === completed) return;
  item.chat_status = status;
  item.completed_run = completed;
  updateRequirementSessionsView(requirement);
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
  if (q && container) container.outerHTML = renderRequirementSessions(q);
}

async function refreshRequirementSessions(id, force = true) {
  const previous = requirementSessions.get(id);
  if (previous?.loading) return;
  if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < 10000) return;
  const data = { sessions: previous?.sessions || [], loading: true, error: '', checkedAt: Date.now() };
  requirementSessions.set(id, data);
  try {
    const result = await api(`/api/requirements/${encodeURIComponent(id)}/sessions`);
    data.sessions = result.sessions;
    data.error = result.error || '';
  } catch (error) { data.error = error.message; }
  finally { data.loading = false; updateRequirementSessionsView(id); }
}

function renderSessionPicker() {
  const linked = new Set((requirementSessions.get(sessionPickerRequirement)?.sessions || []).map(s => s.id));
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
    const page = await api('/api/codex/sessions?' + params);
    if (generation !== sessionPickerGeneration) return;
    const byID = new Map((more ? sessionPickerItems : []).map(s => [s.id, s]));
    page.data.forEach(s => byID.set(s.id, s));
    sessionPickerItems = [...byID.values()];
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
  await mutation('正在关联会话', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(requirement)}/sessions`, { method: 'POST', body: JSON.stringify({ session_id: id }) });
    await refreshRequirementSessions(requirement);
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
    const result = await api(`/api/requirements/${encodeURIComponent(id)}/sessions/${encodeURIComponent(target.dataset.session)}/resume`, { method: 'POST', body: '{}' });
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
