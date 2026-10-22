'use strict';

function renderRequirements() {
  if (!state.projects.length) return empty('先连接你的第一个项目', '添加项目后，就可以围绕一项开发目标，选择相关项目创建任务。', 'new-project', '添加项目');
  if (!state.requirements.length) return empty('为下一项开发工作，创建一个任务', '选好主项目和参与项目，从本地 master 创建各项目的分支与独立工作目录。', 'new-requirement', '创建第一个任务');
  const text = $('#search').value.trim().toLowerCase();
  const reqs = state.requirements.filter(q => ($('#archiveFilter').checked || q.state !== 'archived') && `${q.name} ${q.slug} ${q.branch}`.toLowerCase().includes(text));
  if (!reqs.length) return empty('没有匹配的任务', '尝试其他关键词，或勾选“显示归档”。');
  return reqs.map(q => {
    const primary = q.members.find(m => m.project_id === q.primary_project_id);
    return `<a class="list-row" href="#/requirements/${esc(q.id)}" aria-label="打开任务 ${esc(q.name)}"><span class="row-icon">▤</span><div class="row-main"><div class="row-title">${esc(q.name)} ${badge(q.state)}</div><div class="row-subtitle"><span>${q.members.length} 个项目 · 主项目 ${esc(primary?.project_name)}</span><code>⑂ ${esc(q.branch)}</code></div></div><div class="row-meta"><span>${q.members.filter(m => m.worktree?.dirty > 0).length} 个项目有修改</span><span class="row-time">${new Date(q.created_at).toLocaleDateString('zh-CN')}</span></div><span class="chevron">›</span></a>`;
  }).join('');
}

function canOpenMember(m) {
  const t = m.worktree;
  return m.state === 'ready' && t?.status_updated_at && !t.bare && !t.missing && !t.prunable && !t.error;
}

function requirementDetail(q) {
  const ready = q.state === 'ready' && q.members.every(m => canOpenMember(m) && !m.worktree.detached && m.worktree.branch === q.branch);
  const pending = m => !m.worktree?.status_updated_at && state.projects.find(p => p.id === m.project_id)?.refreshing;
  const workspaceBadge = q.state === 'ready' && !ready ? q.members.some(pending) ? badge('neutral', '状态检查中') : badge('warning', '工作区需检查') : badge(q.state);
  const primary = q.members.find(m => m.project_id === q.primary_project_id);
  const rows = [...q.members].sort((a, b) => Number(b.project_id === q.primary_project_id) - Number(a.project_id === q.primary_project_id)).map(m => {
    const t = m.worktree;
    const usable = canOpenMember(m);
    return `<tr><td><strong>${esc(m.project_name)} ${m.project_id === q.primary_project_id ? badge('primary-tag', '主项目') : ''}</strong><div class="path">${esc(m.path)}</div></td><td>${t ? branch(t.branch) : '<span class="quiet">尚未读取</span>'}${t && t.branch !== q.branch ? `<div class="table-message">分支已变化，预期 ${esc(q.branch)}</div>` : ''}${t?.compare_available ? `<div class="comparison">相对 master：↑ ${t.ahead} ↓ ${t.behind}</div>` : ''}</td><td><span class="branch">master</span><div class="comparison">${esc(m.base_commit.slice(0, 8))}</div></td><td>${m.state === 'ready' ? treeState(t, pending(m)) : badge(m.state)}${m.error ? `<div class="table-message">${esc(m.error)}</div>` : ''}${t?.error ? `<div class="table-message">${esc(t.error)}</div>` : ''}</td><td><div class="workspace-project-actions"><button type="button" class="button small secondary" data-action="workspace-terminal" data-id="${esc(m.project_id)}" data-path="${esc(m.path)}" aria-label="打开 ${esc(m.project_name)} 的终端" ${usable ? '' : 'disabled'}>打开终端 ↗</button><button type="button" class="button small subtle" data-action="git-open" data-id="${esc(m.project_id)}" data-path="${esc(m.path)}" aria-label="打开 ${esc(m.project_name)} 的 Git 操作" ${usable ? '' : 'disabled'}>Git 操作</button></div>${!usable ? '<div class="table-message">' + (pending(m) ? '正在检查工作目录…' : '工作目录不可用') + '</div>' : ''}</td></tr>`;
  }).join('');
  return `<div class="detail requirement-workspace"><div class="detail-top"><div><h2>关联项目 ${workspaceBadge}</h2><div class="detail-path">${esc(q.path)}</div></div><div class="detail-actions"><button type="button" class="button small secondary" data-action="add-requirement-projects" data-id="${esc(q.id)}" ${q.state === 'archived' || q.state === 'creating' || q.members.length >= 30 ? 'disabled' : ''}>＋ 添加项目</button>${q.state === 'partial' ? `<button class="button small subtle" data-action="retry" data-id="${esc(q.id)}">↻ 重试失败项</button>` : ''}<button class="button small secondary" data-action="command" data-id="${esc(q.id)}" ${ready ? '' : 'disabled'}>复制启动命令</button><button class="button small primary" data-action="launch" data-id="${esc(q.id)}" ${ready ? '' : 'disabled'}>↗ 打开终端 · Codex</button><button class="button small secondary" data-action="archive" data-id="${esc(q.id)}">${q.state === 'archived' ? '取消归档' : '归档'}</button></div></div>${q.description ? `<p class="description">${esc(q.description)}</p>` : ''}<div class="detail-summary"><span>关联项目 <b>${q.members.length} 个</b></span><span>主目录 <b>${esc(primary?.project_name)}</b></span><span>所有项目从 <b>本地 master</b> 创建</span></div><div class="table-scroll"><table><thead><tr><th>项目 / 工作目录</th><th>实际分支</th><th>创建基线</th><th>状态</th><th>进入工作目录</th></tr></thead><tbody>${rows}</tbody></table></div><div class="banner note">各项目的终端和 Git 操作直接进入上表对应的工作目录。${esc(state.terminal.message || '')}</div>${renderRequirementSessions(q)}</div>`;
}

function openRequirement() {
  if (state.busy) return;
  if (!state.projects.length) { openProject(); return; }
  const form = $('#requirementForm'); form.reset(); $('#requirementError').hidden = true;
  $('#primaryProject').innerHTML = '<option value="">请选择主项目</option>' + state.projects.map(p => `<option value="${esc(p.id)}" ${!p.has_master || p.error ? 'disabled' : ''}>${esc(p.name)}${!p.status_updated_at ? '（正在检查）' : !p.has_master ? '（缺少 master）' : ''}${p.error ? '（不可用）' : ''}</option>`).join('');
  $('#projectPicker').innerHTML = state.projects.map(p => `<label class="project-option"><input type="checkbox" name="project_ids" value="${esc(p.id)}" ${!p.has_master || p.error ? 'disabled' : ''}><span>${esc(p.name)}<small>${esc(p.path)}</small></span>${!p.status_updated_at ? badge('neutral', '正在检查') : !p.has_master ? badge('warning', '缺少 master') : badge('neutral', 'master')}</label>`).join('');
  const missingMaster = state.projects.filter(p => p.status_updated_at && !p.has_master && !p.error);
  $('#masterPreparation').hidden = !missingMaster.length;
  $('#masterPreparation').innerHTML = missingMaster.length ? `${missingMaster.length} 个项目缺少本地 master，创建前可先获取远端并准备分支。<button type="button" class="button small secondary" data-action="git-prepare-project" data-id="${esc(missingMaster[0].id)}">前往准备 ${esc(missingMaster[0].name)}</button>` : '';
  updatePreview(); $('#requirementDialog').showModal();
}

function updatePreview() {
  const form = $('#requirementForm');
  const primary = form.elements.primary_project_id.value;
  $('#projectPicker').querySelectorAll('input').forEach(input => {
    const project = state.projects.find(p => p.id === input.value);
    if (input.value === primary) input.checked = true;
    input.disabled = input.value === primary || !project.has_master || !!project.error;
  });
  const selected = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => state.projects.find(p => p.id === i.value));
  const path = workspaceDisplayPath(state.root, form.elements.slug.value || '<目录标识>');
  $('#workspacePreview').textContent = path + '/\n' + selected.map((p, i) => `${i === selected.length - 1 ? '└─' : '├─'} ${p.folder}/${p.id === primary ? '  ← 主项目' : ''}`).join('\n');
}

$('#requirementForm').addEventListener('input', event => {
  const form = event.currentTarget;
  if (event.target.name === 'name' && !form.elements.slug.dataset.edited) {
    form.elements.slug.value = form.elements.name.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  if (event.target.name === 'slug') form.elements.slug.dataset.edited = '1';
  if ((event.target.name === 'name' || event.target.name === 'slug') && !form.elements.branch.dataset.edited) form.elements.branch.value = 'codex/' + form.elements.slug.value;
  if (event.target.name === 'branch') form.elements.branch.dataset.edited = '1';
  updatePreview();
});
$('#requirementForm').addEventListener('reset', event => { delete event.target.elements.slug.dataset.edited; delete event.target.elements.branch.dataset.edited; });
$('#requirementForm').addEventListener('change', updatePreview);
$('#requirementForm').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.target);
  const primary = data.get('primary_project_id');
  const projectIDs = [...$('#projectPicker').querySelectorAll('input:checked')].map(i => i.value);
  const body = { name: data.get('name'), slug: data.get('slug'), description: data.get('description'), branch: data.get('branch'), primary_project_id: primary, project_ids: projectIDs };
  mutation('正在从 master 创建全部 Worktree', async () => {
    const q = await api('/api/requirements', { method: 'POST', body: JSON.stringify(body) });
    state.requirements.unshift(q); navigate('/requirements/' + q.id); $('#search').value = ''; $('#requirementDialog').close();
    toast(q.state === 'ready' ? '任务已创建，全部项目已就绪' : '任务已保存，部分项目创建失败，可单独重试', q.state !== 'ready');
  }, $('#requirementError'));
});
