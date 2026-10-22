'use strict';

const terminalLabels = { 'macos-terminal': 'Terminal（macOS）', 'windows-terminal': 'Windows Terminal', powershell: 'PowerShell（Windows 本机）', otty: 'Otty', custom: '自定义路径', auto: '系统终端' };
const terminalStyleLabels = { otty: 'Otty', 'windows-terminal': 'Windows Terminal', command: '其他终端（支持 -e 程序 参数）' };
let terminalOptionsKey = '';

function renderTerminalOptions() {
  const terminal = state.terminal;
  const saved = terminal.settings;
  const kinds = [...(terminal.supported_kinds || ['windows-terminal', 'powershell', 'otty', 'custom', 'auto'])];
  const styles = [...(terminal.supported_styles || ['otty', 'windows-terminal', 'command'])];
  if (!kinds.includes(saved.kind)) kinds.push(saved.kind);
  if (saved.kind === 'custom' && !styles.includes(saved.style)) styles.push(saved.style);
  $('#terminalKind').innerHTML = kinds.map(kind => `<option value="${esc(kind)}">${esc(kind === 'auto' ? terminal.platform === 'darwin' ? '系统终端（macOS）' : '系统终端（Linux）' : terminalLabels[kind] || kind)}</option>`).join('');
  $('#terminalStyle').innerHTML = styles.map(style => `<option value="${esc(style)}">${esc(terminalStyleLabels[style] || style)}</option>`).join('');
  $('#terminalPath').placeholder = terminal.platform === 'darwin' ? '/完整路径/终端命令行程序' : terminal.platform === 'windows' ? 'C:\\完整路径\\terminal.exe' : '/usr/bin/terminal';
  terminalOptionsKey = JSON.stringify([terminal.platform, terminal.supported_kinds, terminal.supported_styles]);
}

function refreshTerminalOptions() {
  const terminal = state.terminal;
  if (terminalOptionsKey === JSON.stringify([terminal.platform, terminal.supported_kinds, terminal.supported_styles])) return;
  const kind = $('#terminalKind').value, style = $('#terminalStyle').value;
  renderTerminalOptions();
  $('#terminalKind').value = kind;
  $('#terminalStyle').value = style;
}

function updateTerminalFields() {
  const kind = $('#terminalKind').value;
  const custom = kind === 'custom';
  $('#terminalCustomFields').hidden = !custom;
  $('#terminalPath').required = custom;
  $('#terminalPath').disabled = !custom;
  $('#terminalStyle').disabled = !custom;
  $('#terminalHint').textContent = kind === 'macos-terminal' || kind === 'auto' && state.terminal.platform === 'darwin'
    ? '使用 macOS 系统 Terminal 打开项目工作目录，命令结束后保留终端。Codex 启动后等待你输入。'
    : kind === 'otty'
    ? '自动检测 Otty 命令行程序，在新标签页打开项目；未运行时会先启动 Otty。未找到时可用自定义路径指定安装目录下的 bin/otty.exe。'
    : kind === 'windows-terminal'
      ? '使用 Windows Terminal 的 wt.exe 打开新窗口。'
      : kind === 'powershell' ? '使用独立 PowerShell 窗口打开 Windows 本机项目。'
        : custom ? '仅支持所选启动方式兼容的终端；程序不可用时会提示错误，保留你的选择。' : '自动使用可用的 Linux 桌面终端。';
  $('#terminalStatus').hidden = kind !== state.terminal.settings?.kind;
}

function loadTerminalFields() {
  const saved = state.terminal.settings;
  renderTerminalOptions();
  $('#terminalKind').value = saved.kind;
  $('#terminalPath').value = saved.path || '';
  $('#terminalStyle').value = saved.kind === 'custom' ? saved.style : state.terminal.supported_styles?.[0] || 'otty';
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
