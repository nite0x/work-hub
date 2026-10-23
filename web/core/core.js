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
const badge = (kind, text) => window.WorkHubUI.badge(kind, text);
const branch = value => window.WorkHubUI.branch(value);
const allTrees = () => state.projects.flatMap(p => p.worktrees);
let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toastMessage').textContent = message;
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
  return window.WorkHubUI.stat(label, value, caption, symbol);
}

function empty(title, description, action, button) {
  return window.WorkHubUI.empty(title, description, action, button);
}

function treeState(t, pending = false) {
  return window.WorkHubUI.treeState(t, pending);
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
