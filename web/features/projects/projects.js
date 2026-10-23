'use strict';

let projectAddedCallback = null;
let projectOpenTool;

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
  if (!projects.length) return empty('没有匹配的项目', '试试其他项目名称或路径。');
  return window.WorkHubUI.projects(projects, state.selectedProject);
}

function openProject(onAdded = null, environment = activeEnvironment) {
  if (state.busy) return;
  projectAddedCallback = onAdded;
  $('#projectForm').reset(); $('#projectError').hidden = true; $('#projectDialog').showModal();
  $('#projectEnvironmentSelect').innerHTML = environmentOptions();
  $('#projectEnvironmentSelect').value = environment;
  $('#projectEnvironmentSelect').disabled = !!onAdded;
}

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
  document.querySelectorAll('.task-action-menu[open]').forEach(menu => {
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
