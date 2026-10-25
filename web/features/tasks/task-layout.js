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
