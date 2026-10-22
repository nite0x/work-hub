'use strict';
const newSessionRequests = new Map();
const newSessionProjects = new Map();

function prepareNewSession(current) {
  const q = state.requirements.find(q => q.id === current.requirement);
  const pending = newSessionRequests.get(q.id);
  const selected = newSessionProjects.get(q.id) || pending?.project_id || q.primary_project_id;
  $('#sessionHistoryTitle').textContent = '新建会话';
  $('#newSessionProject').innerHTML = q.members.map(m => `<option value="${esc(m.project_id)}" ${m.project_id === selected ? 'selected' : ''}>${esc(m.project_name)}${m.project_id === q.primary_project_id ? '（主项目）' : ''}</option>`).join('');
  $('#newSessionProject').value = q.members.some(m => m.project_id === selected) ? selected : q.primary_project_id;
  updateNewSessionProject(current);
  $('#sessionHistoryEntries').innerHTML = `<div class="session-new-empty"><span class="eyebrow">LET’S GET STARTED</span><h3>从这里开始对话</h3><p>描述你想完成的工作，Codex 将在所选项目中开始。会话会自动关联「${esc(q.name)}」。</p></div>`;
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
  if (sessionHistoryState?.requirement === q.id && !sessionHistoryState.session) { $('#sessionChatInput').focus(); return; }
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
  const project = $('#newSessionProject').value;
  const old = newSessionRequests.get(current.requirement);
  const pending = old?.text === text && old.project_id === project ? old : { text, project_id: project, request_id: crypto.randomUUID() };
  newSessionRequests.set(current.requirement, pending);
  if (!pending.promise) {
    const { text, project_id, request_id } = pending;
    pending.promise = api(`/api/requirements/${encodeURIComponent(current.requirement)}/sessions/new`, { method: 'POST', body: JSON.stringify({ text, project_id, request_id }) });
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
    if (newSessionRequests.get(requirement) === pending) newSessionRequests.delete(requirement);
    // A finished request must not erase a different draft or replace a panel
    // opened while the creation was in flight.
    if (chatDrafts.get(chatDraftKey(current)) === pending.text) chatDrafts.delete(chatDraftKey(current));
    updateRequirementSessionsView(requirement);
    if (sessionHistoryState === current) {
      openSessionHistory(requirement, result.session.id);
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
