'use strict';
let environmentInventory = [];
async function loadEnvironments() {
  const data = await api('/api/environments');
  environmentInventory = data.environments;
  $('#environmentSelect').innerHTML = data.environments.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  $('#environmentSelect').value = activeEnvironment;
  $('#reconnectEnvironment').hidden = activeEnvironment === 'local';
  $('#environmentDistro').innerHTML = data.distributions.map(name => `<option>${esc(name)}</option>`).join('');
  $('#addEnvironment').disabled = !data.distributions.length;
  $('#addEnvironment').title = data.wsl_message || '连接已安装的 WSL 发行版';
  $('#connectEnvironment').disabled = !data.distributions.length;
  $('#environmentStatus').textContent = data.environments.find(e => e.id === activeEnvironment)?.name || '执行环境未登记';
  renderSettings();
}
async function selectEnvironment(id, route = '#/requirements') {
  if (state.busy || state.refreshing) { $('#environmentSelect').value = activeEnvironment; toast('请等待当前操作完成后切换环境'); return; }
  closeSessionHistory(false);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  requirementSessions.clear();
  activeEnvironment = id;
  const url = new URL(location.href);
  if (id === 'local') url.searchParams.delete('environment'); else url.searchParams.set('environment', id);
  url.hash = route;
  history.replaceState(null, '', url);
  Object.assign(state, { projects: [], requirements: [], selectedProject: null, selectedRequirement: null, view: 'requirements', root: '', terminal: {}, master_sync: null, loaded: false });
  readRoute();
  $('#search').value = '';
  $('#content').textContent = '正在连接执行环境…';
  $('#reconnectEnvironment').hidden = id === 'local';
  $('#environmentSelect').value = id;
  $('#environmentStatus').textContent = environmentInventory.find(e => e.id === id)?.name || id;
  render();
  await refresh();
}
$('#environmentSelect').addEventListener('change', event => selectEnvironment(event.target.value, state.view === 'settings' ? '#/settings' : '#/requirements'));
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('environment') || 'local';
  if (id === activeEnvironment) return;
  if (state.busy || state.refreshing) {
    const url = new URL(location.href);
    if (activeEnvironment === 'local') url.searchParams.delete('environment'); else url.searchParams.set('environment', activeEnvironment);
    history.replaceState(null, '', url);
    toast('请等待当前操作完成后切换环境');
    return;
  }
  selectEnvironment(id, location.hash || '#/requirements');
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
  if (connected) await selectEnvironment(connected.id, '#/settings');
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
