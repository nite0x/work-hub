'use strict';

function renderHistoryAttention(current) {
  const confirmations = current.pushConfirmations || [];
  const visible = current.pushWaiting || confirmations.length > 0;
  const container = $('#sessionHistoryAttention');
  container.hidden = !visible;
  if (!visible) { current.attentionSignature = null; container.textContent = ''; return; }
  const signature = JSON.stringify([current.pushConnected, current.pushWaiting, confirmations]);
  if (current.attentionSignature === signature) return;
  current.attentionSignature = signature;
  container.innerHTML = window.WorkHubUI.historyAttention(current.pushConnected, confirmations.map(cleanHistoryApproval));
}

function mergeHistoryPush(current, entries) {
  const byID = new Map(current.entries.map(entry => [historyEntryKey(entry), entry]));
  for (const entry of entries) {
    const key = historyEntryKey(entry);
    const old = byID.get(key);
    byID.set(key, { ...old, ...entry, started_at_ms: entry.started_at_ms ?? old?.started_at_ms, completed_at_ms: entry.completed_at_ms ?? old?.completed_at_ms });
  }
  current.entries = [...byID.values()];
}

function applyHistoryPush(current, push) {
  if (sessionHistoryState !== current) return;
  current.pushConnected = push.connected;
  current.pushStatus = push.connected ? '' : (push.message || '实时连接中断') + ' · 每秒补读历史';
  if (push.connected) {
    current.pushConfirmations = push.confirmations || [];
    current.pushWaiting = !!push.waiting;
    current.pushSnapshot = push.entries || [];
    const signature = JSON.stringify(current.pushSnapshot);
    if (signature !== current.pushSignature) {
      current.pushSignature = signature;
      current.pushRevision = (current.pushRevision || 0) + 1;
      mergeHistoryPush(current, current.pushSnapshot);
      renderHistoryTimeline(current);
    }
    if (current.pushSync !== undefined && current.pushSync !== push.sync) current.pushNeedsSync = true;
    current.pushSync = push.sync;
  }
  renderHistoryAttention(current);
  updateHistoryToolbar(current);
}

async function startHistoryPush(current) {
  // The compatibility chat client already has its own live subscription.
  if (!current?.session || sessionHistoryState !== current || !sessionReadOnly || document.hidden || current.pushRunning || Date.now() < (current.pushRetryAt || 0)) return;
  current.pushRunning = true;
  const controller = new AbortController();
  current.pushAbort = controller;
  const environment = current.environment;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(current.session)}/history/events`, {
      headers: { 'X-CSRF-Token': token, 'X-Environment-ID': environment }, signal: controller.signal
    });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || '实时连接失败'); }
    if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) throw new Error('服务未返回实时事件流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (sessionHistoryState === current && !controller.signal.aborted) {
      const chunk = await reader.read();
      if (sessionHistoryState !== current || controller.signal.aborted) break;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data: ')) applyHistoryPush(current, JSON.parse(event.slice(6)));
      }
    }
  } catch (error) {
    if (sessionHistoryState === current && error.name !== 'AbortError') current.pushStatus = '实时连接暂不可用 · 每秒补读历史并自动重连';
  } finally {
    controller.abort();
    current.pushRunning = false;
    current.pushConnected = false;
    current.pushRetryAt = document.hidden ? 0 : Date.now() + 5000;
    if (sessionHistoryState === current) {
      if (!document.hidden) current.pushStatus = '实时连接断开 · 每秒补读历史并自动重连';
      renderHistoryAttention(current);
      updateHistoryToolbar(current);
    }
  }
}
