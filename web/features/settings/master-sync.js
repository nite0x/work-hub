'use strict';

function masterSyncResults(run) {
  return window.WorkHubUI.syncResults(run);
}

function renderMasterSync() {
  const v = state.master_sync;
  if (!v) return;
  const html = masterSyncResults(v.last_run);
  if ($('#masterSyncResults').innerHTML !== html) $('#masterSyncResults').innerHTML = html;
}

function loadMasterSyncFields() {
  const v = state.master_sync;
  $('#masterSyncEnabled').checked = v.settings.enabled;
  $('#masterSyncTime').value = v.settings.time;
  $('#masterSyncError').hidden = true;
}

$('#masterSyncForm').addEventListener('submit', event => {
  event.preventDefault();
  mutation('正在保存每日拉取设置', async () => {
    const result = await api('/api/settings/master-sync', { method: 'PUT', body: JSON.stringify({ enabled: $('#masterSyncEnabled').checked, time: $('#masterSyncTime').value }) });
    state.master_sync.settings = result;
    renderMasterSync();
    toast('每日拉取设置已保存');
  }, $('#masterSyncError'));
});
