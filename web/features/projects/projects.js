'use strict';

let projectAddedCallback = null;

function renderProjects() {
  if (!state.projects.length) return empty('你的项目，从这里连接', '输入已有 Git 仓库的主目录。已有 worktree 会自动发现，后续每 10 秒刷新本地状态。', 'new-project', '添加第一个项目');
  const text = $('#search').value.trim().toLowerCase();
  const projects = state.projects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(text));
  if (!projects.length) return empty('没有匹配的项目', '试试其他项目名称或路径。');
  let html = `<div class="project-list">${projects.map(p => `<button class="project-card ${p.id === state.selectedProject ? 'selected' : ''}" data-action="select-project" data-id="${esc(p.id)}"><div class="project-card-top"><strong>${esc(p.name)}</strong><span class="project-dot ${p.error || (p.status_updated_at && !p.has_master) ? 'invalid' : ''}"></span></div><span class="path">${esc(p.path)}</span><div class="project-card-bottom"><span>${p.worktrees.length} 个 worktree</span><span>·</span><span>${p.worktrees.filter(t => t.dirty).length} 个有修改</span>${!p.status_updated_at && p.refreshing ? badge('neutral', '正在检查') : !p.has_master ? badge('warning', '无本地 master') : ''}</div></button>`).join('')}</div>`;
  const selected = projects.find(p => p.id === state.selectedProject);
  if (!selected) return html;
  const p = selected;
  const rows = p.worktrees.map(t => `<tr><td><strong>${esc(t.path.split('/').pop())} ${t.path === p.path ? badge('primary-tag', '登记目录') : ''}${t.locked ? badge('neutral', '已锁定') : ''}${t.detached ? badge('warning', 'Detached') : ''}</strong><div class="path">${esc(t.path)}</div></td><td>${branch(t.branch)}${t.compare_available ? `<div class="comparison">相对 master：↑ ${t.ahead} ↓ ${t.behind}</div>` : ''}</td><td>${t.requirement_id ? `<button class="button small subtle" data-action="jump-requirement" data-id="${esc(t.requirement_id)}">${esc(t.requirement_name)} ↗</button>` : '<span class="quiet">未关联任务</span>'}</td><td>${treeState(t)}${t.error ? `<div class="table-message">${esc(t.error)}</div>` : ''}</td><td><button class="button small secondary" data-action="copy-path" data-path="${esc(t.path)}">复制路径</button></td></tr>`).join('');
  html += `<div class="detail"><div class="detail-top"><div><div class="eyebrow">PROJECT DETAIL</div><h2>${esc(p.name)}</h2><div class="detail-path">${esc(p.path)}</div></div><div class="detail-actions"><button type="button" class="button small primary" data-action="new-worktree" data-id="${esc(p.id)}" ${p.error ? 'disabled' : ''}>＋ 创建 Worktree</button><button type="button" class="button small secondary" data-action="git-open" data-id="${esc(p.id)}">Git 操作 · 分支管理</button><button class="button small secondary" data-action="remove-project" data-id="${esc(p.id)}">移除登记</button></div></div><div class="detail-summary"><span>自动发现 <b>${p.worktrees.length} 个 worktree</b></span><span>更新间隔 <b>10 秒</b></span><span>任务基线 <b>master</b></span></div>${p.error ? `<div class="banner error">${esc(p.error)}</div>` : `<div class="table-scroll"><table><thead><tr><th>工作目录</th><th>分支 / 相对 master</th><th>关联任务</th><th>修改状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}${p.status_updated_at && !p.has_master ? `<div class="banner note">该仓库缺少本地 master。先在 Git 操作中获取远端分支，再选择正确来源创建本地 master。<button type="button" class="button small primary" data-action="git-open" data-id="${esc(p.id)}">准备 master 分支</button></div>` : ''}</div>`;
  return html;
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
