'use strict';

let projectAddedCallback = null;

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
  const button = event.target.closest('[data-action^="project-open-"]');
  if (!button || button.disabled || state.busy) return;
  const tool = button.dataset.action.slice('project-open-'.length);
  mutation(tool === 'remote' ? '正在打开远端仓库' : '正在打开项目编辑器', async () => {
    const result = await api(`/api/projects/${encodeURIComponent(button.dataset.id)}/open`, { method: 'POST', body: JSON.stringify({ tool, path: button.dataset.path }) });
    toast(result.message);
  });
});
