'use strict';

let settingsEnvironment = null;

function renderSettings() {
  const environment = environmentInventory.find(e => e.id === activeEnvironment);
  $('#settingsEnvironment').textContent = environment?.name || (activeEnvironment === 'local' ? '本机' : activeEnvironment);
  $('#settingsRoot').textContent = state.root || '等待执行环境连接后读取';
  $('#terminalSettingsFields').disabled = !state.loaded || !state.terminal.settings;
  $('#masterSyncSettingsFields').disabled = !state.loaded || !state.master_sync;
  if (!state.loaded) {
    settingsEnvironment = null;
    $('#terminalStatus').textContent = '等待执行环境连接后读取终端配置';
    $('#masterSyncResults').textContent = '等待执行环境连接后读取执行结果';
    return;
  }
  // Forms live outside the polled content panel. Initialize once per environment
  // so background Git updates and navigation preserve unfinished edits.
  if (settingsEnvironment !== activeEnvironment) {
    if (state.terminal.settings) loadTerminalFields();
    if (state.master_sync) loadMasterSyncFields();
    settingsEnvironment = activeEnvironment;
  }
  $('#terminalStatus').textContent = (state.terminal.message || '') + (state.terminal.launcher ? '\n程序：' + state.terminal.launcher : '');
  updateTerminalFields();
  renderMasterSync();
}
