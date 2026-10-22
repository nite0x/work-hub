'use strict';

function updateTerminalFields() {
  const kind = $('#terminalKind').value;
  const custom = kind === 'custom';
  $('#terminalCustomFields').hidden = !custom;
  $('#terminalPath').required = custom;
  $('#terminalPath').disabled = !custom;
  $('#terminalStyle').disabled = !custom;
  $('#terminalHint').textContent = kind === 'otty'
    ? '自动检测 Otty 命令行程序，在新标签页打开项目；未运行时会先启动 Otty。未找到时可用自定义路径指定安装目录下的 bin/otty.exe。'
    : kind === 'windows-terminal'
      ? '使用 Windows Terminal 的 wt.exe 打开新窗口。'
      : kind === 'powershell' ? '使用独立 PowerShell 窗口打开 Windows 本机项目。'
        : custom ? '仅支持所选启动方式兼容的终端；程序不可用时会提示错误，保留你的选择。' : '自动使用可用的 Linux 桌面终端。';
  $('#terminalStatus').hidden = kind !== state.terminal.settings?.kind;
}

function loadTerminalFields() {
  const saved = state.terminal.settings;
  $('#terminalKind').value = saved.kind;
  $('#terminalPath').value = saved.path || '';
  $('#terminalStyle').value = saved.kind === 'custom' ? saved.style : 'otty';
  $('#terminalAutoOption').hidden = saved.kind !== 'auto';
  $('#terminalError').hidden = true;
  updateTerminalFields();
}

$('#terminalKind').addEventListener('change', updateTerminalFields);
$('#terminalForm').addEventListener('submit', event => {
  event.preventDefault();
  const kind = $('#terminalKind').value;
  const body = { kind, path: kind === 'custom' ? $('#terminalPath').value.trim() : '', style: kind === 'custom' ? $('#terminalStyle').value : kind };
  mutation('正在保存终端设置', async () => {
    state.terminal = await api('/api/settings/terminal', { method: 'PUT', body: JSON.stringify(body) });
    $('#terminalStatus').textContent = state.terminal.message + (state.terminal.launcher ? '\n程序：' + state.terminal.launcher : '');
    updateTerminalFields();
    toast(state.terminal.launcher ? '终端设置已保存，所有终端入口将使用此配置' : '终端设置已保存。' + state.terminal.message, !state.terminal.launcher);
  }, $('#terminalError'));
});
