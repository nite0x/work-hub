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
  if (window.WorkHubUI.notifyWorkspace) {
    $('#toast').hidden = true;
    window.WorkHubUI.notifyWorkspace(message, error);
    return;
  }
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

const operations = window.WorkHubUI.createOperations();
function syncMutationControls() {
  const pending = operations.snapshot();
  const active = new Set(pending.map(item => String(item.id)));
  document.querySelectorAll('[data-operation-disabled]').forEach(control => {
    if (!active.has(control.dataset.operationDisabled)) {
      control.disabled = control.dataset.operationWasDisabled === 'true';
      delete control.dataset.operationDisabled; delete control.dataset.operationWasDisabled;
    }
  });
  for (const operation of pending) {
    if (operation.environment !== activeEnvironment) continue;
    const roots = operation.project ? [...document.querySelectorAll('[data-project-id]')].filter(node => node.dataset.projectId === operation.project) : [];
    const controls = roots.flatMap(root => [...root.querySelectorAll('button[data-action]:not([data-action="copy-path"]):not([data-action="changes-open"])')]);
    if (operation.task) controls.push(...[...document.querySelectorAll('button[data-id]')].filter(button => button.dataset.id === operation.task && !['task-review','task-conversations','task-project-filter','copy-path'].includes(button.dataset.action)));
    for (const control of controls) {
      if (!control.dataset.operationDisabled) control.dataset.operationWasDisabled = String(control.disabled);
      control.dataset.operationDisabled = String(operation.id); control.disabled = true;
    }
  }
  $('#busyPanel').hidden = !pending.length;
  if (pending.length) $('#busyTitle').textContent = pending[pending.length - 1].title + (pending.length > 1 ? `（共 ${pending.length} 项操作）` : '');
}
function blockingMutationDialog() { return document.querySelector('dialog[open][data-block-close]'); }
async function mutation(title, fn, errorElement, options = {}) {
  const scope = errorElement?.closest?.('dialog') || options.scope || null;
  const environment = options.environment || activeEnvironment;
  const task = options.task || (!options.project && state.selectedRequirement && scope?.id !== 'requirementDialog' ? state.selectedRequirement : undefined);
  const key = options.key || (options.project ? 'project:' + options.project : task ? 'task:' + task : scope?.id || title);
  const operation = operations.begin({key, environment, title, project: options.project, task});
  if (!operation) { toast('同一工作现场的操作仍在进行，请稍候'); return; }
  if (scope) {
    scope.dataset.mutation = String(operation.id);
    if (!options.background) scope.dataset.blockClose = '';
    for (const control of scope.querySelectorAll('button,input,select,textarea')) {
      if (options.background && control.classList.contains('close-dialog')) continue;
      control.dataset.operationWasDisabled = String(control.disabled);
      control.dataset.operationDisabled = String(operation.id); control.disabled = true;
    }
  }
  syncMutationControls();
  if (errorElement) errorElement.hidden = true;
  const isCurrent = options.isCurrent || (() => environment === activeEnvironment && (!scope || scope.dataset.mutation === String(operation.id)));
  try { await fn(); }
  catch (error) {
    if (errorElement && isCurrent()) { errorElement.textContent = error.message; errorElement.hidden = false; } else toast(title + '：' + error.message, true);
    if (error.command && isCurrent()) showCommand(error.command);
  } finally {
    operations.end(operation);
    if (scope?.dataset.mutation === String(operation.id)) { delete scope.dataset.mutation; delete scope.dataset.blockClose; }
    syncMutationControls();
    await refresh();
  }
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
