'use strict';

let settingsEnvironment = null;
let titleSettingsEnvironment = null;
let titleSettingsLoading = false;
let titleSettingsRevision = 0;

async function loadSessionTitleSettings() {
  const environment = activeEnvironment;
  const revision = ++titleSettingsRevision;
  titleSettingsEnvironment = environment;
  titleSettingsLoading = true;
  $('#sessionTitleFields').disabled = true;
  $('#sessionTitleReload').disabled = true;
  $('#sessionTitleError').hidden = true;
  try {
    const result = await api('/api/settings/session-title', { environment });
    if (environment !== activeEnvironment || revision !== titleSettingsRevision) return;
    const model = result.settings.model || '';
    const models = result.models || [];
    $('#sessionTitleModel').innerHTML = '<option value="">跟随正文模型</option>'
      + (model && !models.some(m => m.model === model) ? `<option value="${esc(model)}">${esc(model)}（当前不可用）</option>` : '')
      + models.map(m => `<option value="${esc(m.model)}">${esc(m.displayName || m.model)}</option>`).join('');
    $('#sessionTitleModel').value = model;
    $('#sessionTitleFields').disabled = false;
  } catch (error) {
    if (environment !== activeEnvironment || revision !== titleSettingsRevision) return;
    $('#sessionTitleError').textContent = error.message;
    $('#sessionTitleError').hidden = false;
  } finally {
    if (environment === activeEnvironment && revision === titleSettingsRevision) {
      titleSettingsLoading = false;
      $('#sessionTitleReload').disabled = !state.loaded;
    }
  }
}

$('#sessionTitleReload').addEventListener('click', () => { if (state.loaded && !titleSettingsLoading) loadSessionTitleSettings(); });
$('#sessionTitleForm').addEventListener('submit', event => {
  event.preventDefault();
  const environment = activeEnvironment;
  const model = $('#sessionTitleModel').value;
  mutation('正在保存标题设置', async () => {
    await api('/api/settings/session-title', { method: 'PUT', body: JSON.stringify({ model }) });
    if (environment === activeEnvironment) toast('标题设置已保存，将用于新对话的标题生成');
  }, $('#sessionTitleError'));
});

function renderSettings() {
  const environment = environmentInventory.find(e => e.id === activeEnvironment);
  $('#settingsEnvironment').textContent = environment?.name || (activeEnvironment === 'local' ? '本机' : activeEnvironment);
  $('#settingsRoot').textContent = state.root || '等待执行环境连接后读取';
  $('#terminalSettingsFields').disabled = !state.loaded || !state.terminal.settings;
  if (!state.loaded) {
    settingsEnvironment = null;
    titleSettingsEnvironment = null;
    titleSettingsRevision++;
    titleSettingsLoading = false;
    $('#sessionTitleFields').disabled = true;
    $('#sessionTitleReload').disabled = true;
    $('#terminalStatus').textContent = '等待执行环境连接后读取终端配置';
    return;
  }
  if (state.view === 'settings' && titleSettingsEnvironment !== activeEnvironment) loadSessionTitleSettings();
  // Forms live outside the polled content panel. Initialize once per environment
  // so background Git updates and navigation preserve unfinished edits.
  if (settingsEnvironment !== activeEnvironment) {
    if (state.terminal.settings) loadTerminalFields();
    settingsEnvironment = activeEnvironment;
  } else if (state.terminal.settings) {
    refreshTerminalOptions();
  }
  $('#terminalStatus').textContent = (state.terminal.message || '') + (state.terminal.launcher ? '\n程序：' + state.terminal.launcher : '');
  updateTerminalFields();
}
