'use strict';

const masterSyncLabels = { pending: '等待执行', updated: '已更新', current: '已是最新', skipped: '已跳过', failed: '失败' };

function masterSyncResults(run) {
  if (!run) return '<p class="quiet">尚未执行每日拉取。</p>';
  const status = { running: '执行中', completed: '执行完成', interrupted: '执行被中断，未完成项目请手动检查' }[run.status] || run.status;
  return `<p>${esc(run.date)} · ${esc(status)}</p><div class="table-scroll"><table><thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead><tbody>${run.results.map(result => `<tr><td>${esc(result.project_name)}</td><td>${esc(masterSyncLabels[result.status] || result.status)}</td><td>${esc(result.message)}</td></tr>`).join('')}</tbody></table></div>`;
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
