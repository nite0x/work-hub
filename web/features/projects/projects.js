'use strict';

let projectAddedCallback = null;
let projectOpenTool;
let projectFilter = 'all';
let projectDetailOpen = false;

const projectWidthKey = 'workhub:project-list-width:v1';
let projectListWidth = 248;
let projectResizeDrag = null;
try {
  const saved = Number(localStorage.getItem(projectWidthKey));
  if (Number.isFinite(saved) && saved >= 200 && saved <= 10000) projectListWidth = saved;
} catch { /* Keep the default when storage is unavailable. */ }
$('#content').style.setProperty('--project-list-width', projectListWidth + 'px');

function projectResizeBounds() {
  const workspace = $('.project-workspace');
  if (!workspace || window.innerWidth <= 1020) return null;
  const width = workspace.getBoundingClientRect().width;
  return width >= 568 ? { min: 200, max: Math.floor(width - 368) } : null;
}
function syncProjectResize() {
  const handle = $('[data-project-resize]');
  const bounds = projectResizeBounds();
  if (!handle || !bounds) return;
  handle.setAttribute('aria-valuemax', String(bounds.max));
  handle.setAttribute('aria-valuenow', String(Math.round($('#projectListPane').getBoundingClientRect().width)));
}
function resizeProjectList(width) {
  const bounds = projectResizeBounds();
  if (!bounds) return;
  projectListWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
  $('#content').style.setProperty('--project-list-width', projectListWidth + 'px');
  syncProjectResize();
}
function rememberProjectWidth() {
  try { localStorage.setItem(projectWidthKey, String(projectListWidth)); } catch { /* Retain the in-memory width. */ }
}
function finishProjectResize(event) {
  if (!projectResizeDrag || event?.pointerId != null && event.pointerId !== projectResizeDrag.id) return;
  const drag = projectResizeDrag;
  projectResizeDrag = null;
  const content = $('#content');
  document.querySelectorAll('.project-workspace[data-resizing]').forEach(node => delete node.dataset.resizing);
  if (content.hasPointerCapture?.(drag.id)) content.releasePointerCapture(drag.id);
  if (drag.moved) rememberProjectWidth();
}
document.addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-project-resize]');
  if (!handle || event.button !== 0 || projectResizeDrag || !projectResizeBounds()) return;
  event.preventDefault();
  handle.focus({ preventScroll: true });
  projectResizeDrag = { id: event.pointerId, x: event.clientX, width: $('#projectListPane').getBoundingClientRect().width, moved: false };
  $('.project-workspace').dataset.resizing = '';
  // Capture on the stable host so polling can replace the markup during a drag.
  $('#content').setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!projectResizeDrag || event.pointerId !== projectResizeDrag.id) return;
  if (!projectResizeBounds()) { finishProjectResize(event); return; }
  projectResizeDrag.moved = true;
  resizeProjectList(projectResizeDrag.width + event.clientX - projectResizeDrag.x);
  $('.project-workspace').dataset.resizing = '';
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, finishProjectResize);
document.addEventListener('keydown', event => {
  if (!event.target.closest('[data-project-resize]')) return;
  const bounds = projectResizeBounds();
  if (!bounds || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width = $('#projectListPane').getBoundingClientRect().width;
  resizeProjectList(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
  rememberProjectWidth();
});
window.addEventListener('resize', () => { if (!projectResizeBounds()) finishProjectResize(); syncProjectResize(); });
window.addEventListener('blur', () => finishProjectResize());
window.addEventListener('pagehide', () => finishProjectResize());
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(syncProjectResize);
  observer.observe($('#content'));
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}

function preferredProjectOpenTool() {
  if (projectOpenTool) return projectOpenTool;
  try { projectOpenTool = localStorage.getItem('workhub:project-open:v1'); } catch { /* Use the default without storage. */ }
  if (!['vscode', 'idea', 'terminal'].includes(projectOpenTool)) projectOpenTool = 'vscode';
  return projectOpenTool;
}

function rememberProjectOpenTool(choice) {
  const tool = choice.dataset.projectOpenChoice;
  if (!['vscode', 'idea', 'terminal'].includes(tool)) return;
  projectOpenTool = tool;
  try { localStorage.setItem('workhub:project-open:v1', tool); } catch { /* Keep the preference for this page. */ }
  const label = { vscode: 'VS Code', idea: 'IDEA', terminal: '终端' }[tool];
  document.querySelectorAll('[data-project-open-primary]').forEach(button => {
    button.dataset.action = tool === 'terminal' ? 'workspace-terminal' : 'project-open-' + tool;
    button.setAttribute('aria-label', `用 ${label} 打开工作目录`);
    button.querySelector('[data-project-open-label]').textContent = label + ' 打开';
    button.querySelector('svg')?.replaceWith(choice.querySelector('svg').cloneNode(true));
  });
}

function positionTaskMenu(menu) {
  if (!menu.open) return;
  const panel = menu.querySelector('.task-action-menu-body, .task-project-details-body');
  if (!panel) return;
  const anchor = (menu.closest('.task-split-action') || menu).getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const left = menu.classList.contains('task-project-details') ? anchor.right - bounds.width : anchor.left;
  panel.style.left = Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)) + 'px';
  const below = window.innerHeight - anchor.bottom;
  const top = below < bounds.height + 8 && anchor.top > below ? anchor.top - bounds.height - 6 : anchor.bottom + 6;
  panel.style.top = Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) + 'px';
}
document.addEventListener('toggle', event => {
  if (event.target.matches('.task-action-menu, .task-project-details')) positionTaskMenu(event.target);
}, true);
function positionOpenTaskMenus() {
  document.querySelectorAll('.task-action-menu[open], .task-project-details[open]').forEach(positionTaskMenu);
}
document.addEventListener('scroll', positionOpenTaskMenus, true);
window.addEventListener('resize', positionOpenTaskMenus);

function renderProjects() {
  if (!state.projects.length) return empty('你的项目，从这里连接', '输入已有 Git 仓库的主目录。已有 worktree 会自动发现，后续每 10 秒刷新本地状态。', 'new-project', '添加第一个项目');
  const text = $('#search').value.trim().toLowerCase();
  const projects = state.projects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(text));
  return window.WorkHubUI.projects(projects, state.selectedProject, preferredProjectOpenTool(), projectFilter, projectDetailOpen);
}

function openProject(onAdded = null, environment = activeEnvironment) {
  if (state.busy) return;
  projectAddedCallback = onAdded;
  $('#projectForm').reset(); $('#projectError').hidden = true; $('#projectDialog').showModal();
  $('#projectEnvironmentSelect').innerHTML = environmentOptions();
  $('#projectEnvironmentSelect').value = environment;
  $('#projectEnvironmentSelect').disabled = !!onAdded;
  updateProjectDirectoryPicker();
}

function updateProjectDirectoryPicker() {
  const remote = $('#projectEnvironmentSelect').value !== 'local';
  $('#chooseProjectDirectory').disabled = remote;
  $('#projectDirectoryHint').hidden = !remote;
}

$('#projectEnvironmentSelect').addEventListener('change', updateProjectDirectoryPicker);
$('#chooseProjectDirectory').addEventListener('click', async () => {
  if (state.busy || $('#projectEnvironmentSelect').value !== 'local') return;
  const button = $('#chooseProjectDirectory');
  const environment = $('#projectEnvironmentSelect');
  const environmentWasDisabled = environment.disabled;
  environment.disabled = true;
  button.disabled = true;
  button.textContent = '正在选择…';
  try {
    await mutation('请在系统窗口中选择仓库文件夹', async () => {
      const result = await api('/api/dialogs/directory', { environment: 'local', method: 'POST', body: '{}' });
      if (result.path && environment.value === 'local') {
        $('#projectPath').value = result.path;
        $('#projectPath').dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, $('#projectError'));
  } finally {
    environment.disabled = environmentWasDisabled;
    button.textContent = '选择文件夹…';
    updateProjectDirectoryPicker();
    $('#projectPath').focus();
  }
});

$('#projectForm').addEventListener('submit', async event => {
  event.preventDefault(); const data = new FormData(event.target);
  const onAdded = projectAddedCallback;
  const environment = $('#projectEnvironmentSelect').value;
  let added;
  await mutation('正在登记并扫描仓库', async () => {
    added = await api('/api/projects', { environment, method: 'POST', body: JSON.stringify({ name: data.get('name'), path: data.get('path') }) });
    $('#projectDialog').close(); toast('项目已登记，正在扫描 worktree');
  }, $('#projectError'));
  if (added && onAdded) await onAdded(added.id);
  else if (added) {
    await selectEnvironment(environment, '/projects');
    state.selectedProject = added.id; $('#search').value = ''; render();
  }
});

document.addEventListener('click', event => {
  const choice = event.target.closest('[data-project-open-choice]');
  if (choice && !choice.disabled && !state.busy) rememberProjectOpenTool(choice);
  document.querySelectorAll('.task-action-menu[open], .project-more[open]').forEach(menu => {
    if (!menu.contains(event.target) || event.target.closest('button:not(:disabled)')) menu.open = false;
  });
  const button = event.target.closest('[data-action^="project-open-"]');
  if (!button || button.disabled || state.busy) return;
  const tool = button.dataset.action.slice('project-open-'.length);
  mutation(tool === 'remote' ? '正在打开远端仓库' : '正在打开项目编辑器', async () => {
    const result = await api(`/api/projects/${encodeURIComponent(button.dataset.id)}/open`, { method: 'POST', body: JSON.stringify({ tool, path: button.dataset.path }) });
    toast(result.message);
  });
});
