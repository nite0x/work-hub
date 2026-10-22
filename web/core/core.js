'use strict';

const $ = (q, root = document) => root.querySelector(q);
const token = $('meta[name="csrf-token"]').content;
let sessionReadOnly = $('meta[name="session-mode"]')?.content === 'read-only';
let activeEnvironment = new URLSearchParams(location.search).get('environment') || 'local';
let environmentRevision = 0;
let taskInventory = { requirements: [], environments: [], project_count: 0, loaded: false };
function environmentName(id = activeEnvironment) {
  const entries = typeof environmentInventory !== 'undefined' ? environmentInventory : [];
  return entries.find(e => e.id === id)?.name || taskInventory.environments.find(e => e.id === id)?.name || (id === 'local' ? '本机' : id);
}
const state = { view: 'requirements', projects: [], requirements: [], selectedProject: null, selectedRequirement: null, root: '', terminal: {}, busy: false, refreshing: false, loaded: false };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { ready: '已就绪', partial: '部分就绪', archived: '已归档', creating: '创建中', pending: '待创建', failed: '创建失败' };
const badge = (kind, text) => `<span class="badge ${esc(kind)}">${esc(text || labels[kind] || kind)}</span>`;
const branch = value => `<span class="branch">⑂ ${esc(value || 'detached HEAD')}</span>`;
const allTrees = () => state.projects.flatMap(p => p.worktrees);
let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4500);
}

async function api(path, options = {}) {
  const { environment = activeEnvironment, ...requestOptions } = options;
  const revision = environmentRevision;
  const scoped = options.environment === undefined;
  const response = await fetch(path, { ...requestOptions, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Environment-ID': environment, ...requestOptions.headers } });
  if (scoped && revision !== environmentRevision) throw new DOMException('执行环境已切换', 'AbortError');
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的响应，请查看服务日志。'); }
  if (scoped && revision !== environmentRevision) throw new DOMException('执行环境已切换', 'AbortError');
  if (!response.ok) {
    const error = new Error([data.error, ...(data.details || [])].filter(Boolean).join('\n'));
    error.command = data.command;
    error.code = data.code;
    throw error;
  }
  return data;
}

function stat(label, value, caption, symbol) {
  return `<div class="stat" title="${esc(caption)}"><div class="stat-label"><span class="stat-symbol" aria-hidden="true">${symbol}</span>${esc(label)}</div><div class="stat-value">${value}</div></div>`;
}

function empty(title, description, action, button) {
  return `<div class="empty"><div class="empty-icon">${action === 'new-project' ? '◇' : '⑂'}</div><h2>${esc(title)}</h2><p>${esc(description)}</p>${action ? `<button class="button primary" data-action="${action}">＋ ${esc(button)}</button>` : ''}</div>`;
}

function treeState(t, pending = false) {
  if (!t) return badge(pending ? 'neutral' : 'failed', pending ? '正在发现目录' : '目录未发现');
  if (t.missing) return badge('failed', '目录丢失');
  if (t.error) return badge('failed', '读取失败');
  if (t.prunable) return badge('warning', '待修复登记');
  if (!t.status_updated_at) return badge('neutral', '正在检查');
  const checked = new Date(t.status_updated_at).toLocaleTimeString('zh-CN', { hour12: false });
  return (t.dirty ? badge('warning', `${t.dirty} 项修改`) : badge('ready', '干净')) + `<div class="comparison status-checked-at">上次检查 <time data-status-path="${esc(t.path)}" datetime="${esc(t.status_updated_at)}">${esc(checked)}</time></div>`;
}

function workspaceDisplayPath(root, ...parts) {
  const separator = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + separator + parts.join(separator);
}

async function mutation(title, fn, errorElement) {
  if (state.busy) return;
  state.busy = true; document.body.classList.add('busy'); $('#busyTitle').textContent = title; $('#busyPanel').hidden = false;
  if (errorElement) errorElement.hidden = true;
  try { await fn(); }
  catch (error) {
    if (errorElement) { errorElement.textContent = error.message; errorElement.hidden = false; } else toast(error.message, true);
    if (error.command) showCommand(error.command);
  } finally { state.busy = false; document.body.classList.remove('busy'); $('#busyPanel').hidden = true; await refresh(); }
}

function showCommand(command) {
  $('#commandTitle').textContent = '终端命令';
  $('#commandDialog .eyebrow').textContent = 'TERMINAL COMMAND';
  $('#commandDialog .dialog-description').textContent = '在当前执行环境的终端执行以下命令；Windows 本机使用 PowerShell。';
  $('#commandText').value = command; if (!$('#commandDialog').open) $('#commandDialog').showModal();
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { showCommand(text); toast('请在弹窗中选择并复制内容'); }
}
