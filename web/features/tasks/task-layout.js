'use strict';

// The chat island lives outside #content: Git polling can replace task markup
// without remounting a composer, losing approvals or interrupting an SSE stream.
const taskWorkspaceMemory = new Map();
let taskWorkspaceCurrent = null;
const taskWorkspaceKey = (environment, task) => JSON.stringify([environment, task]);
function taskWorkspaceValue(key) {
  if (taskWorkspaceMemory.has(key)) return taskWorkspaceMemory.get(key);
  let saved;
  try { saved = JSON.parse(localStorage.getItem('workhub:workspace:v1:' + key)); } catch { /* Memory works without storage. */ }
  const value = {
    mode: ['split', 'expanded', 'collapsed'].includes(saved?.mode) ? saved.mode : 'collapsed',
    ratio: Number.isFinite(saved?.ratio) ? Math.min(.65, Math.max(.25, saved.ratio)) : .4,
    session: typeof saved?.session === 'string' || saved?.session === null ? saved.session : undefined,
    view: saved?.view === 'sessions' ? 'sessions' : 'projects',
    scrollTop: Number.isFinite(saved?.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
    sessionTop: Number.isFinite(saved?.sessionTop) ? Math.max(0, saved.sessionTop) : 0,
    details: Array.isArray(saved?.details) ? saved.details.filter(id => typeof id === 'string') : [],
  };
  taskWorkspaceMemory.set(key, value);
  return value;
}
function persistTaskWorkspace() {
  if (!taskWorkspaceCurrent) return;
  try { localStorage.setItem('workhub:workspace:v1:' + taskWorkspaceCurrent.key, JSON.stringify(taskWorkspaceCurrent.value)); } catch { /* Keep memory fallback. */ }
}
function saveTaskWorkspace() {
  if (!taskWorkspaceCurrent) return;
  const value = taskWorkspaceCurrent.value;
  captureTaskScroll();
  value.details = [...document.querySelectorAll('#content details[data-workspace-detail][open]')].map(node => node.dataset.workspaceDetail);
  persistTaskWorkspace();
}
function captureTaskScroll() {
  if (!taskWorkspaceCurrent || taskWorkspaceCurrent.value.mode === 'expanded') return;
  if ($('#taskWorkspaceLayout').getBoundingClientRect().width && !$('#taskWorkArea').getBoundingClientRect().width) return;
  if (!$('#taskProjectsView').hidden) taskWorkspaceCurrent.value.scrollTop = $('#taskProjectsView').scrollTop;
  if (!$('#taskSessionsView').hidden) taskWorkspaceCurrent.value.sessionTop = $('#taskSessionsView').scrollTop;
}
function suspendTaskWorkspace() {
  saveTaskWorkspace();
  finishTaskResize();
  taskWorkspaceCurrent = null;
}
function taskConversationStatus() {
  if (!taskWorkspaceCurrent) return '';
  const sessions = requirementSessions.get(taskWorkspaceCurrent.task.id)?.sessions || [];
  if (sessions.some(s => s.chat_status === 'waiting')) return '待确认';
  if (sessions.some(s => ['starting', 'running', 'stopping', 'handoff'].includes(s.chat_status))) return '执行中';
  if (sessions.some(s => sessionWithUnread(s).unread)) return '有新消息';
  return '';
}
function updateTaskConversationStatus() {
  const status = taskConversationStatus();
  document.querySelectorAll('[data-task-chat-status]').forEach(node => { node.textContent = status ? ' · ' + status : ''; });
  const selected = taskWorkspaceCurrent?.value.session;
  document.querySelectorAll('[data-session-row]').forEach(row => row.classList.toggle('is-selected', row.dataset.sessionRow === selected));
}
function applyTaskWorkspace(event) {
  if (event?.type !== 'resize') window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail: {phase: 'before'}}));
  const current = taskWorkspaceCurrent;
  const layout = $('#taskWorkspaceLayout');
  const mode = current?.value.mode || 'collapsed';
  layout.dataset.mode = mode;
  const width = layout.getBoundingClientRect().width;
  // Each pane stays usable. On narrower viewports CSS provides one-pane mode.
  const min = width > 760 ? Math.max(.25, 340 / width) : .25;
  const max = width > 760 ? Math.min(.65, 1 - 369 / width) : .65;
  const ratio = Math.max(min, Math.min(max, current?.value.ratio || .4));
  layout.style.setProperty('--chat-width', `${ratio * 100}%`);
  const tabbed = !!current && mode === 'split';
  $('#taskToolsTabs').hidden = !tabbed;
  $('#taskProjectsView').hidden = tabbed && current.value.view === 'sessions';
  $('#taskSessionsView').hidden = !current || tabbed && current.value.view !== 'sessions';
  for (const view of ['projects', 'sessions']) {
    const tab = view === 'projects' ? $('#taskProjectsTab') : $('#taskSessionsTab');
    const panel = view === 'projects' ? $('#taskProjectsView') : $('#taskSessionsView');
    const selected = current?.value.view === view;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    panel.setAttribute('role', tabbed ? 'tabpanel' : 'region');
    if (tabbed) panel.setAttribute('aria-labelledby', tab.id); else panel.removeAttribute('aria-labelledby');
  }
  $('#taskConversation').hidden = !current || mode === 'collapsed';
  $('#taskSplitHandle').hidden = !current || mode !== 'split';
  $('#taskOverviewHandle').hidden = !current || mode !== 'collapsed';
  for (const handle of [$('#taskSplitHandle'), $('#taskOverviewHandle')]) {
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    handle.setAttribute('aria-valuemin', String(Math.ceil(min * 100)));
    handle.setAttribute('aria-valuemax', String(Math.floor(max * 100)));
    handle.setAttribute('aria-valuetext', `${mode === 'collapsed' ? '会话列表' : '对话'}占 ${Math.round(ratio * 100)}%`);
  }
  const expand = document.querySelector('[data-task-layout="expand"]');
  expand.textContent = mode === 'expanded' ? '还原' : '展开';
  expand.setAttribute('aria-label', mode === 'expanded' ? '还原对话' : '展开对话');
  expand.title = expand.getAttribute('aria-label');
  expand.hidden = !!current && width > 0 && width <= 760;
  $('#taskConversationEmpty').hidden = !$('#sessionHistoryPanel').hidden;
  if (current && mode !== 'expanded') {
    $('#taskProjectsView').scrollTop = current.value.scrollTop;
    $('#taskSessionsView').scrollTop = current.value.sessionTop;
  }
  updateTaskConversationStatus();
  // Restore scroll after display:none, including width-dependent text wrapping.
  window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail: {visible: !!current && mode !== 'collapsed'}}));
}
function syncTaskWorkspace(task) {
  const key = task ? taskWorkspaceKey(activeEnvironment, task.id) : null;
  const changed = key !== taskWorkspaceCurrent?.key;
  if (changed) { finishTaskResize(); if (sessionHistoryState) closeSessionHistory(false); }
  if (!task) {
    taskWorkspaceCurrent = null;
    $('#taskSessionsContainer').textContent = '';
    applyTaskWorkspace();
    return;
  }
  if (changed) taskWorkspaceCurrent = {key, task, environment: activeEnvironment, value: taskWorkspaceValue(key)};
  else taskWorkspaceCurrent.task = task;
  window.WorkHubAssistant?.updateTask?.(task);
  const current = taskWorkspaceCurrent;
  if (changed || !$('#requirementSessions')) $('#taskSessionsContainer').innerHTML = renderRequirementSessions(task);
  else updateRequirementSessionsView(task.id);
  document.querySelectorAll('#content details[data-workspace-detail]').forEach(node => { node.open = current.value.details.includes(node.dataset.workspaceDetail); });
  $('#taskProjectsView').scrollTop = current.value.scrollTop;
  $('#taskSessionsView').scrollTop = current.value.sessionTop;
  if (changed && current.value.mode !== 'collapsed' && current.value.session !== undefined) {
    openSessionHistory(task.id, current.value.session);
  }
  applyTaskWorkspace();
}
function taskConversationOpened(requirement, session) {
  const current = taskWorkspaceCurrent;
  if (!current || current.task.id !== requirement || current.environment !== activeEnvironment) return;
  current.value.session = session;
  if (current.value.mode === 'collapsed') current.value.mode = 'split';
  persistTaskWorkspace();
  applyTaskWorkspace();
}
function taskConversationCreated(environment, requirement, session) {
  const value = taskWorkspaceValue(taskWorkspaceKey(environment, requirement));
  if (value.session === null) value.session = session;
  if (taskWorkspaceCurrent?.value === value) { persistTaskWorkspace(); updateTaskConversationStatus(); }
}
function collapseTaskConversation() {
  if (!taskWorkspaceCurrent) return;
  saveTaskWorkspace();
  taskWorkspaceCurrent.value.mode = 'collapsed';
  persistTaskWorkspace(); applyTaskWorkspace();
  const selected = taskWorkspaceCurrent.value.session;
  const target = [...document.querySelectorAll('#requirementSessions [data-session-action]')].find(node => selected ? node.dataset.session === selected : node.dataset.sessionAction === 'new');
  (target || $('#pageTitle')).focus({preventScroll: true});
}
function setTaskChatRatio(ratio) {
  if (!taskWorkspaceCurrent) return;
  captureTaskScroll();
  taskWorkspaceCurrent.value.ratio = Math.min(.65, Math.max(.25, ratio));
  applyTaskWorkspace();
}
document.addEventListener('click', event => {
  const control = event.target.closest('[data-task-layout]');
  if (!control || !taskWorkspaceCurrent) return;
  const current = taskWorkspaceCurrent;
  const action = control.dataset.taskLayout;
  if (action === 'close') return collapseTaskConversation();
  if (action === 'expand') {
    saveTaskWorkspace();
    current.value.mode = current.value.mode === 'expanded' ? 'split' : 'expanded';
  }
  persistTaskWorkspace(); applyTaskWorkspace();
});
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-task-view]');
  if (!tab || !taskWorkspaceCurrent) return;
  saveTaskWorkspace(); taskWorkspaceCurrent.value.view = tab.dataset.taskView;
  persistTaskWorkspace(); applyTaskWorkspace();
});
$('#taskToolsTabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !taskWorkspaceCurrent) return;
  event.preventDefault();
  const view = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'sessions' : taskWorkspaceCurrent.value.view === 'projects' ? 'sessions' : 'projects';
  const tab = view === 'projects' ? $('#taskProjectsTab') : $('#taskSessionsTab');
  tab.click(); tab.focus({preventScroll: true});
});
$('#taskProjectsView').addEventListener('scroll', captureTaskScroll, {passive: true});
$('#taskSessionsView').addEventListener('scroll', captureTaskScroll, {passive: true});
const taskHandles = [$('#taskSplitHandle'), $('#taskOverviewHandle')];
let taskDrag = null;
function finishTaskResize(event) {
  if (!taskDrag) return;
  const pointer = taskDrag.pointer;
  const handle = taskDrag.handle;
  taskDrag = null;
  document.body.classList.remove('task-resizing');
  if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
  persistTaskWorkspace();
}
for (const taskHandle of taskHandles) {
  taskHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !taskWorkspaceCurrent) return;
    const bounds = $('#taskWorkspaceLayout').getBoundingClientRect();
    taskDrag = {pointer: event.pointerId, key: taskWorkspaceCurrent.key, bounds, handle: taskHandle};
    taskHandle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('task-resizing');
    taskHandle.focus({preventScroll: true}); event.preventDefault();
  });
  taskHandle.addEventListener('pointermove', event => {
    if (!taskDrag || taskDrag.pointer !== event.pointerId) return;
    if (taskWorkspaceCurrent?.key !== taskDrag.key) return finishTaskResize();
    if (taskDrag.bounds.width) setTaskChatRatio((taskDrag.bounds.right - event.clientX) / taskDrag.bounds.width);
  });
  taskHandle.addEventListener('pointerup', finishTaskResize);
  taskHandle.addEventListener('pointercancel', finishTaskResize);
  taskHandle.addEventListener('lostpointercapture', finishTaskResize);
  taskHandle.addEventListener('keydown', event => {
    if (!taskWorkspaceCurrent || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ratio = Number(taskHandle.getAttribute('aria-valuenow')) / 100;
    setTaskChatRatio(event.key === 'Home' ? .25 : event.key === 'End' ? .65 : ratio + (event.key === 'ArrowLeft' ? .02 : -.02));
    persistTaskWorkspace();
  });
  taskHandle.addEventListener('dblclick', () => { setTaskChatRatio(.4); persistTaskWorkspace(); });
}
window.addEventListener('resize', applyTaskWorkspace);
window.addEventListener('pagehide', saveTaskWorkspace);
// Escape closes transient menus before folding an active conversation.
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.task-more[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
