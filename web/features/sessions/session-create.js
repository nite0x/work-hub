'use strict';
const newSessionRequests = new Map();
const newSessionProjects = new Map();

function prepareNewSession(current) {
  if (current.target) {
    $('#sessionHistoryTitle').textContent = '新建对话';
    $('#newSessionProjectField').hidden = true;
    $('#sessionHistoryMeta').textContent = current.target.cwd || '';
    $('#sessionHistoryEntries').innerHTML = window.WorkHubUI.newSession('当前目录');
    $('#sessionChatInput').focus();
    return;
  }
  const q = state.requirements.find(q => q.id === current.requirement);
  const pending = newSessionRequests.get(q.id);
  const selected = newSessionProjects.get(q.id) || pending?.project_id || q.primary_project_id;
  $('#sessionHistoryTitle').textContent = '新建对话';
  $('#newSessionProject').innerHTML = q.members.map(m => `<option value="${esc(m.project_id)}" ${m.project_id === selected ? 'selected' : ''}>${esc(m.project_name)}${m.project_id === q.primary_project_id ? '（主项目）' : ''}</option>`).join('');
  $('#newSessionProject').value = q.members.some(m => m.project_id === selected) ? selected : q.primary_project_id;
  updateNewSessionProject(current);
  $('#sessionHistoryEntries').innerHTML = window.WorkHubUI.newSession(q.name);
  if (pending?.promise) watchNewSessionCreation(current, pending);
  else $('#sessionChatInput').focus();
}
function updateNewSessionProject(current) {
  const q = state.requirements.find(q => q.id === current.requirement);
  const project = $('#newSessionProject').value;
  const member = q.members.find(m => m.project_id === project);
  newSessionProjects.set(q.id, project);
  $('#sessionHistoryMeta').textContent = member?.path || '';
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-session-action="new"]');
  if (!button || button.disabled || state.busy) return;
  const q = state.requirements.find(q => q.id === button.dataset.requirement);
  if (!q || q.state !== 'ready') return;
  if (sessionHistoryState?.requirement === q.id && !sessionHistoryState.session) {
    if (typeof taskConversationOpened === 'function') taskConversationOpened(q.id, null);
    (document.querySelector('#assistantChatRoot textarea') || $('#sessionChatInput')).focus(); return;
  }
  openSessionHistory(q.id);
});
$('#newSessionProject').addEventListener('change', () => {
  const current = sessionHistoryState;
  if (current && !current.session && !current.submitting) updateNewSessionProject(current);
});

async function sendNewSession(current) {
  if (sessionHistoryState !== current || current.submitting) return;
  const text = $('#sessionChatInput').value.trim();
  if (!text) return;
  const project = current.target?.project_id || $('#newSessionProject').value;
  const key = current.target ? JSON.stringify([current.environment, current.target]) : current.requirement;
  const old = newSessionRequests.get(key);
  const pending = old?.text === text && old.project_id === project ? old : { text, project_id: project, request_id: crypto.randomUUID(), ...current.target };
  pending.key = key;
  newSessionRequests.set(key, pending);
  if (!pending.promise) {
    const { text, project_id, request_id } = pending;
    pending.promise = api(`/api/sessions/new`, { environment: current.environment, method: 'POST', body: JSON.stringify({ text, project_id, request_id, ...(current.target || { task_id: current.requirement }) }) });
  }
  await watchNewSessionCreation(current, pending);
}
async function watchNewSessionCreation(current, pending) {
  current.submitting = true; current.chatError = ''; renderChatControls(current);
  const promise = pending.promise;
  try {
    const result = await promise;
    const requirement = current.requirement;
    const cached = requirementSessions.get(requirement) || { sessions: [] };
    cached.sessions = [result.session, ...cached.sessions.filter(s => s.id !== result.session.id)];
    requirementSessions.set(requirement, cached);
    if (newSessionRequests.get(pending.key || requirement) === pending) newSessionRequests.delete(pending.key || requirement);
    // A finished request must not erase a different draft or replace a panel
    // opened while the creation was in flight.
    if (chatDrafts.get(chatDraftKey(current)) === pending.text) chatDrafts.delete(chatDraftKey(current));
    updateRequirementSessionsView(requirement);
    if (sessionHistoryState === current) {
      current.browserContext?.created?.(result.session);
      if (current.target) openSessionHistoryPanel(requirement, result.session.id, { ...current.browserContext, session: result.session });
      else openSessionHistory(requirement, result.session.id);
      chatDrafts.delete(chatDraftKey(current));
      sessionHistoryState.newlyCreated = true;
      sessionHistoryState.sentDraft = pending.text;
      applyChatState(sessionHistoryState, result.chat);
      if (result.chat.busy) streamChat(sessionHistoryState, result.chat.id);
    }
  } catch (error) {
    if (sessionHistoryState === current) { current.chatError = error.message; }
  } finally {
    if (pending.promise === promise) delete pending.promise;
    current.submitting = false;
    if (sessionHistoryState === current) renderChatControls(current);
  }
}
