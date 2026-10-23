'use strict';
const chatDrafts = new Map();
const chatLabels = { idle: '可以在这里继续对话', starting: '正在连接并核实会话占用…', running: 'Codex 正在工作…', waiting: '等待你的审批或回答', stopping: '正在请求停止…', completed: '本轮已完成', interrupted: '本轮已停止', failed: '本轮未完成，请检查进展', conflict: '会话暂不可发送' };
chatLabels.handoff = '正在交接：等待终端本轮工作结束…';

function chatPath(current) { return `/api/requirements/${encodeURIComponent(current.requirement)}/sessions/${encodeURIComponent(current.session)}/chat`; }
function chatDraftKey(current) { return current.requirement + ':' + (current.session || 'new'); }
function renderChatTimeline(current) {
  const live = current.chat?.entries || [];
  const liveIDs = new Set(live.map(e => e.turn_id + ':' + e.id));
  const saved = current.entries.filter(e => !liveIDs.has(e.turn_id + ':' + e.id));
  const containers = [$('#sessionHistoryEntries'), $('#sessionChatLiveEntries')];
  const expanded = new Map(containers.flatMap(container => [...container.querySelectorAll('[data-history-entry] details')].map(detail => [detail.closest('[data-history-entry]').dataset.historyEntry, detail.open])));
  const focused = document.activeElement?.closest('[data-history-entry]');
  const focusedKey = focused?.dataset.historyEntry;
  const focusOutput = document.activeElement?.hasAttribute('data-command-output');
  const savedHTML = saved.map(renderHistoryEntry).join('') || (!live.length ? `<p class="session-empty">${current.cursor ? '可加载更早记录。' : '此会话尚无已保存的消息或命令记录。'}</p>` : '');
  if (current.savedHistoryMarkup !== savedHTML) { $('#sessionHistoryEntries').innerHTML = savedHTML; current.savedHistoryMarkup = savedHTML; }
  const liveContainer = $('#sessionChatLiveEntries');
  const liveHTML = live.length ? '<div class="chat-run-heading">本轮对话</div>' + live.map(e => e.kind === 'change' ? window.WorkHubUI.fileChange(plainHistoryText(e.text), e.status) : renderHistoryEntry(e)).join('') : '';
  if (current.liveHistoryMarkup !== liveHTML) { liveContainer.innerHTML = liveHTML; current.liveHistoryMarkup = liveHTML; }
  containers.forEach(container => container.querySelectorAll('[data-history-entry]').forEach(node => {
    const detail = node.querySelector('details');
    if (expanded.has(node.dataset.historyEntry)) detail.open = expanded.get(node.dataset.historyEntry);
    if (node.dataset.historyEntry === focusedKey) node.querySelector(focusOutput ? '[data-command-output]' : 'summary')?.focus({ preventScroll: true });
  }));
  if (typeof syncCommandOutput === 'function') syncCommandOutput(current);
}
function renderChatControls(current) {
  const chat = current.chat;
  const ready = state.requirements.find(q => q.id === current.requirement)?.state === 'ready';
  const isNew = !current.session;
  $('#sendSessionChat').disabled = !ready || current.submitting || !chat || chat.busy || !!chat.blocked || !$('#sessionChatInput').value.trim();
  $('#stopSessionChat').disabled = !chat?.busy || current.stopping || chat.status === 'stopping';
  $('#stopSessionChat').hidden = isNew;
  $('#newSessionProject').disabled = isNew && current.submitting;
  $('#sessionChatInput').disabled = isNew && current.submitting;
  $('#stopSessionChat').textContent = chat?.status === 'handoff' || current.cancelingHandoff ? '取消交接' : '停止';
  $('#handoffSessionChat').hidden = !chat?.can_handoff || chat.busy;
  $('#handoffSessionChat').disabled = current.handingOff || !ready;
  $('#sessionHandoffNotice').textContent = chat?.notice || '';
  $('#sessionHandoffNotice').hidden = !chat?.notice;
  $('#resumeHistorySession').disabled = !!chat?.busy || !ready || !!chat?.blocked;
  $('#sessionChatStatus').textContent = isNew ? (current.submitting ? '正在创建会话并发送…' : '发送第一条消息后，自动创建会话并关联当前任务') : chat?.blocked || (chat ? chatLabels[chat.status] || chat.status : '正在检查会话状态…');
  $('#sessionChatError').textContent = current.chatError || chat?.error || '';
  $('#sessionChatError').hidden = !$('#sessionChatError').textContent;
}
function renderChatApprovals(current) {
  const approvals = current.chat?.approvals || [];
  const signature = JSON.stringify(approvals);
  if (current.approvalSignature === signature) return;
  current.approvalSignature = signature;
  $('#sessionChatApprovals').innerHTML = window.WorkHubUI.chatApprovals(approvals.map(cleanHistoryApproval));
}
function applyChatState(current, chat) {
  if (sessionHistoryState !== current) return;
  const previous = current.chat;
  if (previous?.busy && !chat.id) return;
  if (previous?.id && previous.id === chat.id && (previous.revision || 0) > (chat.revision || 0)) return;
  if (!chat.busy && current.handoffRequest === chat.id) delete current.handoffRequest;
  if (current.pendingMessage && current.pendingMessage.id === chat.id) {
    current.sentDraft = current.pendingMessage.text;
    $('#sessionChatInput').value = '';
    current.pendingMessage = null;
  }
  if (!chat.busy && !chat.turn_id && current.sentDraft && !$('#sessionChatInput').value) $('#sessionChatInput').value = current.sentDraft;
  const scroll = $('#sessionHistoryScroll');
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  current.chat = chat;
  renderChatControls(current);
  renderChatApprovals(current);
  if (JSON.stringify(previous?.entries) !== JSON.stringify(chat.entries)) {
    renderChatTimeline(current);
    if (follow) scroll.scrollTop = scroll.scrollHeight;
  }
  if (previous?.busy && !chat.busy) { loadSessionHistory(); if (typeof refresh === 'function') refresh(true); }
  else if (chat.turn_id && !previous?.turn_id && current.newlyCreated) loadSessionHistory();
}
async function pollChat(current) {
  if (sessionHistoryState !== current || !current.session || current.polling) return;
  current.polling = true;
  try {
    const chat = await api(chatPath(current), { signal: current.chatAbort.signal });
    applyChatState(current, chat);
    if (chat.busy && !current.streaming) streamChat(current, chat.id);
  } catch (error) {
    if (sessionHistoryState === current && error.name !== 'AbortError') { current.chatError = '状态读取失败：' + error.message; renderChatControls(current); }
  } finally { current.polling = false; }
}
async function streamChat(current, id) {
  if (current.streaming || sessionHistoryState !== current) return;
  current.streaming = true;
  try {
    const response = await fetch(chatPath(current) + '/events?run=' + encodeURIComponent(id), { headers: { 'X-CSRF-Token': token }, signal: current.chatAbort.signal });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || '实时连接失败'); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (sessionHistoryState === current) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data: ')) { current.chatError = ''; applyChatState(current, JSON.parse(event.slice(6))); }
      }
    }
  } catch (error) {
    if (sessionHistoryState === current && error.name !== 'AbortError') { current.chatError = '实时连接暂时断开，将自动重连；不会重复发送消息。'; renderChatControls(current); }
  } finally { current.streaming = false; }
}
function openSessionChat(current) {
  current.chatAbort = new AbortController();
  current.chatError = '';
  current.approvalSignature = null;
  $('#sessionChatInput').value = chatDrafts.get(chatDraftKey(current)) || '';
  $('#sessionChatLiveEntries').textContent = '';
  $('#sessionChatApprovals').textContent = '';
  if (!current.session) current.chat = { status: 'idle', busy: false, entries: [], approvals: [] };
  renderChatControls(current);
  if (current.session) {
    pollChat(current);
    current.pollTimer = setInterval(() => { if (!document.hidden) pollChat(current); }, 2000);
  }
}
function closeSessionChat(current) {
  if (!current) return;
  chatDrafts.set(chatDraftKey(current), $('#sessionChatInput').value);
  current.chatAbort?.abort();
  clearInterval(current.pollTimer);
}
$('#sessionChatInput').addEventListener('input', () => { if (sessionHistoryState) renderChatControls(sessionHistoryState); });
$('#sessionChatInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!$('#sendSessionChat').disabled) $('#sessionChatForm').requestSubmit(); }
});
$('#sessionChatForm').addEventListener('submit', async event => {
  event.preventDefault();
  const current = sessionHistoryState;
  if (!current || $('#sendSessionChat').disabled) return;
  if (!current.session) return sendNewSession(current);
  const text = $('#sessionChatInput').value.trim();
  const pending = current.pendingMessage?.text === text ? current.pendingMessage : { text, id: crypto.randomUUID() };
  current.pendingMessage = pending;
  current.submitting = true; current.chatError = ''; renderChatControls(current);
  try {
    const chat = await api(chatPath(current), { method: 'POST', body: JSON.stringify({ text, request_id: pending.id }) });
    if (sessionHistoryState !== current) return;
    applyChatState(current, chat); streamChat(current, chat.id);
  } catch (error) {
    if (sessionHistoryState === current) { current.chatError = error.message; await pollChat(current); }
  } finally { current.submitting = false; if (sessionHistoryState === current) renderChatControls(current); }
});
$('#stopSessionChat').addEventListener('click', async () => {
  const current = sessionHistoryState;
  if (!current?.chat?.busy || current.stopping) return;
  current.cancelingHandoff = current.chat.status === 'handoff';
  current.stopping = true; renderChatControls(current);
  try { applyChatState(current, await api(chatPath(current) + '/stop', { method: 'POST', body: JSON.stringify({ run_id: current.chat.id }) })); }
  catch (error) { if (sessionHistoryState === current) current.chatError = error.message; }
  finally { current.stopping = false; current.cancelingHandoff = false; if (sessionHistoryState === current) renderChatControls(current); }
});
$('#handoffSessionChat').addEventListener('click', async () => {
  const current = sessionHistoryState;
  if (!current?.chat?.can_handoff || current.handingOff || current.chat.busy) return;
  current.handingOff = true; current.chatError = ''; renderChatControls(current);
  current.handoffRequest ||= crypto.randomUUID();
  try {
    const chat = await api(chatPath(current) + '/handoff', { method: 'POST', body: JSON.stringify({ request_id: current.handoffRequest }) });
    applyChatState(current, chat); streamChat(current, chat.id);
  } catch (error) { if (sessionHistoryState === current) { current.chatError = error.message; await pollChat(current); } }
  finally { current.handingOff = false; if (sessionHistoryState === current) renderChatControls(current); }
});
async function answerChatApproval(form, decision) {
  const current = sessionHistoryState;
  if (!current?.chat?.busy || form.dataset.sending) return;
  const answers = {};
  form.querySelectorAll('[data-free-answer-for]').forEach(input => {
    const id = input.dataset.freeAnswerFor;
    const choice = [...form.querySelectorAll('[data-answer-for]')].find(s => s.dataset.answerFor === id);
    answers[id] = [input.value.trim() || choice?.value || ''];
  });
  form.dataset.sending = '1'; form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { applyChatState(current, await api(chatPath(current) + '/approval', { method: 'POST', body: JSON.stringify({ run_id: current.chat.id, approval_id: form.dataset.chatApproval, decision, answers }) })); }
  catch (error) { if (sessionHistoryState === current) { current.chatError = error.message; renderChatControls(current); } }
  finally { delete form.dataset.sending; form.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
$('#sessionChatApprovals').addEventListener('submit', event => { event.preventDefault(); const form = event.target.closest('[data-chat-approval]'); if (form) answerChatApproval(form, 'accept'); });
$('#sessionChatApprovals').addEventListener('click', event => { const button = event.target.closest('[data-chat-decision]'); if (button) answerChatApproval(button.closest('form'), button.dataset.chatDecision); });
