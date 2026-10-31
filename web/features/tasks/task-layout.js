'use strict';

// Workspace refreshes preserve the task's working position. Conversations have
// their own shared host and never participate in the task's layout.
const taskWorkspaceMemory = new Map();
let taskWorkspaceCurrent = null;
function saveTaskWorkspace() {
  if (!taskWorkspaceCurrent) return;
  taskWorkspaceCurrent.scrollTop = $('#taskProjectsView').scrollTop;
  taskWorkspaceCurrent.details = [...document.querySelectorAll('#content details[data-workspace-detail][open]')].map(node => node.dataset.workspaceDetail);
  taskWorkspaceMemory.set(taskWorkspaceCurrent.key, taskWorkspaceCurrent);
}
function suspendTaskWorkspace() { saveTaskWorkspace(); taskWorkspaceCurrent = null; }
function syncTaskWorkspace(task) {
  if (!task) { taskWorkspaceCurrent = null; return; }
  const key = JSON.stringify([activeEnvironment, task.id]);
  taskWorkspaceCurrent = taskWorkspaceMemory.get(key) || { key, scrollTop: 0, details: [] };
  $('#taskProjectsView').scrollTop = taskWorkspaceCurrent.scrollTop;
  document.querySelectorAll('#content details[data-workspace-detail]').forEach(node => { node.open = taskWorkspaceCurrent.details.includes(node.dataset.workspaceDetail); });
  window.WorkHubAssistant?.updateTask?.(task);
}
$('#taskProjectsView').addEventListener('scroll', saveTaskWorkspace, { passive: true });
window.addEventListener('pagehide', saveTaskWorkspace);
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.task-more[open]')) if (!menu.contains(event.target)) menu.open = false;
});

// The stable task shell retains its divider while task content refreshes.
const taskWidthKey = 'workhub:task-list-width:v1';
let taskListWidth = 300;
let taskResizeDrag = null;
try {
  const saved = Number(localStorage.getItem(taskWidthKey));
  if (Number.isFinite(saved) && saved >= 240 && saved <= 640) taskListWidth = saved;
} catch { /* Keep the default when storage is unavailable. */ }
$('#workContent').style.setProperty('--task-list-width', taskListWidth + 'px');
function taskResizeBounds() {
  if (state.view !== 'requirements' || window.innerWidth <= 1100) return null;
  const width = $('#workContent').getBoundingClientRect().width;
  return width >= 668 ? { min: 240, max: Math.min(640, Math.floor(width - 428)) } : null;
}
function syncTaskResize() {
  const handle = $('#taskListResize');
  const bounds = taskResizeBounds();
  handle.hidden = state.view !== 'requirements' || window.innerWidth <= 1100;
  if (!bounds) { finishTaskResize(); return; }
  handle.setAttribute('aria-valuemax', String(bounds.max));
  handle.setAttribute('aria-valuenow', String(Math.round(Math.max(bounds.min, Math.min(bounds.max, taskListWidth)))));
}
function resizeTaskList(width) {
  const bounds = taskResizeBounds();
  if (!bounds) return;
  taskListWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
  $('#workContent').style.setProperty('--task-list-width', taskListWidth + 'px');
  syncTaskResize();
}
function rememberTaskWidth() {
  try { localStorage.setItem(taskWidthKey, String(taskListWidth)); } catch { /* Retain the in-memory width. */ }
}
function finishTaskResize(event) {
  if (!taskResizeDrag || event?.pointerId != null && event.pointerId !== taskResizeDrag.id) return;
  const drag = taskResizeDrag;
  taskResizeDrag = null;
  const workspace = $('#workContent');
  delete workspace.dataset.taskResizing;
  if (workspace.hasPointerCapture?.(drag.id)) workspace.releasePointerCapture(drag.id);
  if (drag.moved) rememberTaskWidth();
}
$('#taskListResize').addEventListener('pointerdown', event => {
  const bounds = taskResizeBounds();
  if (event.button !== 0 || taskResizeDrag || !bounds) return;
  event.preventDefault();
  event.currentTarget.focus({preventScroll:true});
  taskResizeDrag = {id:event.pointerId, x:event.clientX, width:Math.max(bounds.min, Math.min(bounds.max, taskListWidth)), moved:false};
  $('#workContent').dataset.taskResizing = '';
  $('#workContent').setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!taskResizeDrag || event.pointerId !== taskResizeDrag.id) return;
  if (!taskResizeBounds()) { finishTaskResize(event); return; }
  taskResizeDrag.moved = true;
  resizeTaskList(taskResizeDrag.width + event.clientX - taskResizeDrag.x);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, finishTaskResize);
$('#taskListResize').addEventListener('keydown', event => {
  const bounds = taskResizeBounds();
  if (!bounds || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width = Math.max(bounds.min, Math.min(bounds.max, taskListWidth));
  resizeTaskList(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
  rememberTaskWidth();
});
window.addEventListener('resize', syncTaskResize);
window.addEventListener('blur', () => finishTaskResize());
window.addEventListener('pagehide', () => finishTaskResize());
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(syncTaskResize);
  observer.observe($('#workContent'));
  window.addEventListener('pagehide', () => observer.disconnect(), {once:true});
}
