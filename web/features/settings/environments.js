'use strict';
let environmentInventory = [];
function environmentOptions() {
  const entries = environmentInventory.length ? environmentInventory : taskInventory.environments.length ? taskInventory.environments : [{ id: 'local', name: '本机' }];
  return entries.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
}
async function loadEnvironments() {
  const data = await api('/api/environments', { environment: 'local' });
  environmentInventory = data.environments;
  for (const id of ['environmentSelect', 'projectEnvironment', 'sessionsEnvironment']) {
    $('#' + id).innerHTML = environmentOptions();
    $('#' + id).value = activeEnvironment;
  }
  $('#sessionEnvironmentField').hidden = data.environments.length < 2;
  $('#reconnectEnvironment').hidden = activeEnvironment === 'local';
  $('#environmentDistro').innerHTML = data.distributions.map(name => `<option>${esc(name)}</option>`).join('');
  $('#addEnvironment').disabled = !data.distributions.length;
  $('#addEnvironment').hidden = data.wsl_supported === false;
  $('#connectEnvironment').hidden = data.wsl_supported === false;
  $('#platformLabel').textContent = ({ darwin: 'macOS', windows: 'Windows · WSL', linux: 'Linux' })[data.platform] || '本机工作台';
  $('#addEnvironment').title = data.wsl_message || '连接已安装的 WSL 发行版';
  $('#connectEnvironment').disabled = !data.distributions.length;
  $('#environmentStatus').textContent = data.environments.find(e => e.id === activeEnvironment)?.name || '执行环境未登记';
  renderSettings();
}
async function selectEnvironment(id, route = '/requirements', updateHistory = true) {
  if (state.busy) { $('#environmentSelect').value = activeEnvironment; $('#projectEnvironment').value = activeEnvironment; $('#sessionsEnvironment').value = activeEnvironment; toast('请等待当前操作完成后切换环境'); return; }
  route = route.replace(/^#/, '');
  const changed = activeEnvironment !== id;
  if (changed && typeof suspendSessionWorkspace === 'function') suspendSessionWorkspace();
  if (typeof suspendTaskWorkspace === 'function') suspendTaskWorkspace();
  if (changed) closeSessionHistory(false);
  document.querySelectorAll('dialog[open]').forEach(dialog => { if (changed || dialog.id !== 'conversationDialog') dialog.close(); });
  if (changed) requirementSessions.clear();
  if (changed) environmentRevision++;
  activeEnvironment = id;
  const url = new URL(location.href);
  if (id === 'local') url.searchParams.delete('environment'); else url.searchParams.set('environment', id);
  url.hash = route;
  if (updateHistory && url.href !== location.href) history.pushState(null, '', url);
  if (changed) Object.assign(state, { projects: [], requirements: [], selectedProject: null, selectedRequirement: null, view: 'requirements', root: '', terminal: {}, master_sync: null, loaded: false, refreshing: false });
  readRoute();
  $('#search').value = '';
  if (changed) $('#content').textContent = '正在连接任务所属环境…';
  $('#reconnectEnvironment').hidden = id === 'local';
  $('#environmentSelect').value = id;
  $('#projectEnvironment').value = id;
  $('#sessionsEnvironment').value = id;
  $('#environmentStatus').textContent = environmentName(id);
  render();
  await refresh();
}
$('#environmentSelect').addEventListener('change', event => selectEnvironment(event.target.value, '/settings'));
$('#projectEnvironment').addEventListener('change', event => selectEnvironment(event.target.value, '/projects'));
$('#sessionsEnvironment').addEventListener('change', event => selectEnvironment(event.target.value, '/sessions'));
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('environment') || 'local';
  if (state.busy) {
    const url = new URL(location.href);
    if (activeEnvironment === 'local') url.searchParams.delete('environment'); else url.searchParams.set('environment', activeEnvironment);
    history.replaceState(null, '', url);
    toast('请等待当前操作完成后切换环境');
    return;
  }
  selectEnvironment(id, location.hash || '#/requirements', false);
});
$('#addEnvironment').addEventListener('click', async () => {
  if (state.busy) return;
  try { await loadEnvironments(); $('#environmentError').hidden = true; $('#environmentDialog').showModal(); }
  catch (error) { toast(error.message, true); }
});
$('#environmentForm').addEventListener('submit', async event => {
  event.preventDefault();
  let connected;
  await mutation('正在部署并连接 WSL 辅助程序', async () => {
    connected = await api('/api/environments', { method: 'POST', body: JSON.stringify({ distro: $('#environmentDistro').value, user: $('#environmentUser').value.trim(), root: $('#environmentRoot').value.trim(), import_existing: $('#environmentImport').checked }) });
    $('#environmentDialog').close(); await loadEnvironments();
  }, $('#environmentError'));
  if (connected) await selectEnvironment(connected.id, '/settings');
});
$('#reconnectEnvironment').addEventListener('click', async () => {
  await mutation('正在重新连接 WSL', async () => {
    await api(`/api/environments/${encodeURIComponent(activeEnvironment)}/reconnect`, { method: 'POST', body: '{}' });
    await loadEnvironments(); toast('执行环境已重新连接，请检查最近操作结果');
  });
});
window.addEventListener('DOMContentLoaded', () => {
  loadEnvironments().catch(error => { $('#environmentStatus').textContent = error.message; });
});
