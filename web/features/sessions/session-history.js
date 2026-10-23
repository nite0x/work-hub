'use strict';
let sessionHistoryState = null;
const historyRefreshInterval = 1000;

function historyEntryKey(entry) { return JSON.stringify([entry.turn_id, entry.id]); }

function historyCommandStatus(entry) {
  return { completed: '已完成', failed: '失败', declined: '已拒绝', inProgress: '执行中', interrupted: '已停止' }[entry.status] || '状态未记录';
}

function historyCommandMetadata(entry) {
  const metadata = [historyCommandStatus(entry)];
  if (entry.exit_code !== null && entry.exit_code !== undefined) metadata.push('退出码 ' + entry.exit_code);
  if (entry.duration_ms !== null && entry.duration_ms !== undefined) metadata.push('耗时 ' + (entry.duration_ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' 秒');
  return metadata.join(' · ');
}

function stopHistoryRefresh(current) {
  if (!current) return;
  clearInterval(current.historyTimer);
  current.abort?.abort();
  current.pushAbort?.abort();
}

function plainHistoryText(value) {
  // Saved terminal output can contain ANSI colors/cursor controls. Render it
  // as inert text without escape sequences, including in command summaries.
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function historyText(value) { return esc(plainHistoryText(value)); }

function historyViewEntry(entry) {
  return { ...entry, text: plainHistoryText(entry.text), command: plainHistoryText(entry.command), cwd: plainHistoryText(entry.cwd) };
}

function cleanHistoryApproval(item) {
  return { ...item, title: plainHistoryText(item.title), details: plainHistoryText(item.details), questions: (item.questions || []).map(q => ({ ...q, header: plainHistoryText(q.header), question: plainHistoryText(q.question), options: q.options?.map(o => ({ ...o, label: plainHistoryText(o.label), description: plainHistoryText(o.description) })) })) };
}

function renderHistoryEntry(entry) {
  return window.WorkHubUI.historyEntry(historyViewEntry(entry), historyCommandMetadata(entry));
}

function findHistoryCommand(current, key) {
  return [...(current.chat?.entries || []), ...current.entries].find(entry => entry.kind === 'command' && historyEntryKey(entry) === key);
}

function syncCommandOutput(current) {
  if (!current.commandOutputKey || !$('#sessionCommandOutputDialog').open) return;
  const entry = findHistoryCommand(current, current.commandOutputKey) || current.commandOutputEntry;
  if (!entry) return;
  current.commandOutputEntry = entry;
  $('#sessionCommandOutputCommand').textContent = plainHistoryText(entry.command) || '命令未记录';
  $('#sessionCommandOutputMeta').textContent = historyCommandMetadata(entry) + (entry.cwd ? '\n' + plainHistoryText(entry.cwd) : '');
  const output = $('#sessionCommandOutputText');
  const text = entry.output == null ? (entry.status === 'inProgress' ? '等待命令输出…' : '此记录未保存命令输出。') : plainHistoryText(entry.output) || '（无输出）';
  if (output.textContent !== text) {
    const top = output.scrollTop;
    const follow = output.scrollHeight - top - output.clientHeight < 60;
    output.textContent = text;
    output.scrollTop = follow ? output.scrollHeight : top;
  }
}

function openCommandOutput(key) {
  const current = sessionHistoryState;
  const entry = current && findHistoryCommand(current, key);
  if (!entry) return;
  current.commandOutputKey = key;
  current.commandOutputEntry = entry;
  const dialog = $('#sessionCommandOutputDialog');
  if (!dialog.open) dialog.showModal();
  $('#sessionCommandOutputText').textContent = '';
  syncCommandOutput(current);
  $('#sessionCommandOutputText').scrollTop = 0;
}

function closeCommandOutput() {
  if ($('#sessionCommandOutputDialog').open) $('#sessionCommandOutputDialog').close();
}

function updateHistoryToolbar(current) {
  $('#refreshSessionHistory').disabled = current.loading;
  $('#loadOlderHistory').disabled = current.loading;
  $('#loadOlderHistory').hidden = !current.cursor;
  $('#sessionHistoryStatus').textContent = current.loading && !current.backgroundRefresh ? '正在读取会话历史…' : `${current.entries.length} 条记录${current.cursor ? ' · 可加载更早内容' : ''} · ${current.pushConnected ? '终端实时推送中' : current.pushStatus || '每秒自动刷新'}`;
}

function renderHistoryTimeline(current, older = false, background = true) {
  const scroll = $('#sessionHistoryScroll');
  const heightBefore = scroll.scrollHeight;
  const topBefore = scroll.scrollTop;
  const follow = heightBefore - topBefore - scroll.clientHeight < 100;
  const container = $('#sessionHistoryEntries');
  const expanded = new Map([...container.querySelectorAll('[data-history-entry] details')].map(detail => [detail.closest('[data-history-entry]').dataset.historyEntry, detail.open]));
  if (typeof renderChatTimeline === 'function') renderChatTimeline(current);
  else {
    const markup = current.entries.length ? current.entries.map(renderHistoryEntry).join('') : `<p class="session-empty">${current.cursor ? '本页暂无消息或命令，可继续加载更早记录。' : '此会话尚无已保存的消息或命令记录。'}</p>`;
    if (current.savedHistoryMarkup !== markup) { container.innerHTML = markup; current.savedHistoryMarkup = markup; }
  }
  container.querySelectorAll('[data-history-entry] details').forEach(detail => {
    const key = detail.closest('[data-history-entry]').dataset.historyEntry;
    if (expanded.has(key)) detail.open = expanded.get(key);
  });
  syncCommandOutput(current);
  updateHistoryToolbar(current);
  scroll.scrollTop = older ? topBefore + scroll.scrollHeight - heightBefore : background && !follow ? topBefore : scroll.scrollHeight;
}

async function loadSessionHistory(older = false, background = false) {
  const current = sessionHistoryState;
  if (current?.assistant || !current?.session || current.loading || (older && !current.cursor)) return;
  current.loading = true;
  current.backgroundRefresh = background;
  current.abort = new AbortController();
  updateHistoryToolbar(current);
  $('#sessionHistoryError').hidden = true;
  const pushRevision = current.pushRevision;
  const query = older ? '?cursor=' + encodeURIComponent(current.cursor) : '';
  try {
    const path = `/api/requirements/${encodeURIComponent(current.requirement)}/sessions/${encodeURIComponent(current.session)}/history`;
    let page = await api(path + query, { signal: current.abort.signal });
    if (sessionHistoryState !== current) return;
    let fresh = page.entries;
    const known = new Set(current.entries.map(historyEntryKey));
    const cursors = new Set();
    // Catch up across multiple pages before merging, so a busy terminal cannot
    // leave a gap between the saved records and the newest page.
    while (background && known.size && page.next_cursor && !fresh.some(entry => known.has(historyEntryKey(entry)))) {
      if (cursors.has(page.next_cursor)) throw new Error('历史分页游标重复');
      cursors.add(page.next_cursor);
      page = await api(path + '?cursor=' + encodeURIComponent(page.next_cursor), { signal: current.abort.signal });
      if (sessionHistoryState !== current) return;
      fresh = [...page.entries, ...fresh];
    }
    const byID = new Map();
    const freshIDs = new Set(fresh.map(historyEntryKey));
    const overlap = current.entries.findIndex(entry => freshIDs.has(historyEntryKey(entry)));
    const entries = older ? [...fresh, ...current.entries] : background && overlap >= 0 ? [...current.entries.slice(0, overlap), ...fresh] : fresh;
    entries.forEach(entry => byID.set(historyEntryKey(entry), entry));
    current.entries = [...byID.values()];
    if (current.pushSnapshot && typeof mergeHistoryPush === 'function') {
      mergeHistoryPush(current, current.pushSnapshot.filter(entry => entry.status === 'inProgress' || pushRevision !== current.pushRevision));
    }
    if (!background || overlap < 0) current.cursor = page.next_cursor;
    $('#sessionHistoryTitle').textContent = page.session.name;
    $('#sessionHistoryMeta').textContent = page.session.cwd + '\n' + page.session.id;
    renderHistoryTimeline(current, older, background);
    current.pushNeedsSync = pushRevision !== current.pushRevision;
  } catch (error) {
    if (sessionHistoryState !== current || error.name === 'AbortError') return;
    $('#sessionHistoryError').textContent = error.message + '。可点击“刷新详情”重试。';
    $('#sessionHistoryError').hidden = false;
  } finally {
    if (sessionHistoryState === current) { current.loading = false; updateHistoryToolbar(current); }
  }
}

function openSessionHistory(requirement, session = null) {
  const readonly = typeof sessionReadOnly !== 'undefined' && sessionReadOnly;
  if (readonly && !session) return;
  if (!readonly && window.WorkHubAssistant) {
    closeSessionHistory(false);
    const environment = activeEnvironment;
    const task = state.requirements.find(q => q.id === requirement);
    const cached = requirementSessions.get(requirement)?.sessions.find(s => s.id === session);
    sessionHistoryState = { requirement, session, entries: [], assistant: true };
    const currentPanel = sessionHistoryState;
    const panel = $('#sessionHistoryPanel');
    panel.hidden = false;
    panel.setAttribute('data-assistant-ui', '');
    panel.setAttribute('aria-labelledby', 'assistantChatTitle');
    window.WorkHubAssistant.open({
      task, session: session ? cached || { id: session, name: '会话详情', cwd: '' } : null, environment,
      request: (path, options) => api(path, { ...options, environment }),
      stream: (path, signal) => fetch(path, { headers: { 'X-CSRF-Token': token, 'X-Environment-ID': environment }, signal }),
      close: () => closeSessionHistory(),
      created: created => {
        if (activeEnvironment !== environment) return;
        const data = requirementSessions.get(requirement) || { sessions: [] };
        data.sessions = [created, ...data.sessions.filter(s => s.id !== created.id)];
        requirementSessions.set(requirement, data);
        if (sessionHistoryState === currentPanel) sessionHistoryState.session = created.id;
        updateRequirementSessionsView(requirement);
      }
    });
    return;
  }
  closeCommandOutput();
  if (typeof closeSessionChat === 'function') closeSessionChat(sessionHistoryState);
  stopHistoryRefresh(sessionHistoryState);
  sessionHistoryState = { requirement, session, entries: [], cursor: null, loading: false };
  $('#sessionHistoryAttention').hidden = true;
  $('#sessionHistoryAttention').textContent = '';
  $('#sessionHistoryEyebrow').textContent = session ? 'SESSION HISTORY' : 'NEW CONVERSATION';
  $('#newSessionProjectField').hidden = !!session;
  $('#refreshSessionHistory').hidden = !session;
  $('#resumeHistorySession').hidden = !session;
  $('#sessionChatLabel').textContent = session ? '继续这个会话' : '第一条消息';
  $('#sessionChatInput').placeholder = session ? '补充说明、询问进展，或交代下一步…' : '描述你想完成的工作…';
  $('#sessionHistoryError').hidden = true;
  $('#loadOlderHistory').hidden = true;
  $('#sessionHistoryStatus').textContent = '';
  const cached = requirementSessions.get(requirement)?.sessions.find(s => s.id === session);
  $('#sessionHistoryTitle').textContent = cached?.name || '会话详情';
  $('#sessionHistoryMeta').textContent = cached ? cached.cwd + '\n' + session : session;
  $('#sessionHistoryEntries').textContent = '';
  const resume = $('#resumeHistorySession');
  resume.dataset.requirement = requirement;
  resume.dataset.session = session;
  resume.disabled = state.requirements.find(q => q.id === requirement)?.state !== 'ready' || !cached?.available;
  $('#sessionHistoryPanel').hidden = false;
  $('#sessionChatForm').hidden = readonly;
  $('#sessionHistoryTitle').focus();
  if (!readonly && typeof openSessionChat === 'function') openSessionChat(sessionHistoryState);
  if (session) {
    const current = sessionHistoryState;
    loadSessionHistory().then(() => { if (typeof startHistoryPush === 'function') startHistoryPush(current); });
    current.historyTimer = setInterval(() => {
      if (sessionHistoryState === current && !document.hidden) {
        if (!current.pushConnected || current.pushNeedsSync) loadSessionHistory(false, true);
        if (typeof startHistoryPush === 'function') startHistoryPush(current);
      }
    }, historyRefreshInterval);
  }
  else prepareNewSession(sessionHistoryState);
}

function closeSessionHistory(restoreFocus = true) {
  closeCommandOutput();
  if (sessionHistoryState?.assistant) { window.WorkHubAssistant?.close(); $('#sessionHistoryPanel').removeAttribute('data-assistant-ui'); $('#sessionHistoryPanel').setAttribute('aria-labelledby', 'sessionHistoryTitle'); }
  const current = sessionHistoryState;
  if (!current?.assistant && typeof closeSessionChat === 'function') closeSessionChat(current);
  stopHistoryRefresh(current);
  sessionHistoryState = null;
  $('#sessionHistoryAttention').hidden = true;
  $('#sessionHistoryPanel').hidden = true;
  if (restoreFocus && current) {
    const selector = current.session ? `[data-session-action="details"][data-requirement="${CSS.escape(current.requirement)}"][data-session="${CSS.escape(current.session)}"]` : `[data-session-action="new"][data-requirement="${CSS.escape(current.requirement)}"]`;
    const button = document.querySelector(selector);
    (button || $('#pageTitle')).focus({ preventScroll: true });
  }
}

document.addEventListener('click', event => {
  const output = event.target.closest('[data-command-output]');
  if (output) { openCommandOutput(output.closest('[data-history-entry]').dataset.historyEntry); return; }
  const button = event.target.closest('[data-session-action="details"]');
  if (button && !state.busy) openSessionHistory(button.dataset.requirement, button.dataset.session);
});
$('#closeSessionCommandOutput').addEventListener('click', closeCommandOutput);
$('#sessionCommandOutputDialog').addEventListener('close', () => {
  const current = sessionHistoryState;
  if (!current) return;
  const key = current.commandOutputKey;
  delete current.commandOutputKey;
  delete current.commandOutputEntry;
  const entry = [...$('#sessionHistoryPanel').querySelectorAll('[data-history-entry]')].find(node => node.dataset.historyEntry === key);
  entry?.querySelector('[data-command-output]')?.focus({ preventScroll: true });
});
$('#closeSessionHistory').addEventListener('click', () => closeSessionHistory());
$('#refreshSessionHistory').addEventListener('click', () => loadSessionHistory());
$('#loadOlderHistory').addEventListener('click', () => loadSessionHistory(true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sessionHistoryState && !document.querySelector('dialog[open]')) { event.preventDefault(); closeSessionHistory(); }
});
window.addEventListener('hashchange', () => closeSessionHistory(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sessionHistoryState?.pushAbort?.abort();
  else if (!sessionHistoryState?.assistant) {
    loadSessionHistory(false, true);
    if (typeof startHistoryPush === 'function') startHistoryPush(sessionHistoryState);
  }
});
