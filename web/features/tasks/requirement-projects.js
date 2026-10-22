'use strict';
let requirementProjectsID = null;

function openRequirementProjects(id) {
  if (state.busy) return;
  const q = state.requirements.find(q => q.id === id);
  if (!q || q.state === 'archived' || q.state === 'creating') return;
  requirementProjectsID = id;
  $('#requirementProjectsError').hidden = true;
  $('#requirementProjectPicker').innerHTML = '';
  $('#requirementProjectsDialog').showModal();
  refreshRequirementProjectPicker();
}

function refreshRequirementProjectPicker(selectID = null) {
  if (!$('#requirementProjectsDialog').open) return;
  const q = state.requirements.find(q => q.id === requirementProjectsID);
  if (!q) { $('#requirementProjectsDialog').close(); return; }
  const selected = new Set([...$('#requirementProjectPicker').querySelectorAll('input:checked')].map(i => i.value));
  if (selectID) selected.add(selectID);
  const available = state.projects.filter(p => !q.members.some(m => m.project_id === p.id));
  $('#requirementProjectsDescription').textContent = `为“${q.name}”添加项目，使用任务分支 ${q.branch}。最多关联 30 个项目，当前已有 ${q.members.length} 个。`;
  $('#requirementProjectPicker').innerHTML = available.length ? available.map(p => {
    const unavailable = !!p.error || (!!p.status_updated_at && !p.has_master);
    return `<label class="project-option"><input type="checkbox" name="project_ids" value="${esc(p.id)}" ${unavailable ? 'disabled' : selected.has(p.id) ? 'checked' : ''}><span>${esc(p.name)}<small>${esc(p.path)}</small></span>${p.error ? badge('failed', '不可用') : !p.status_updated_at ? badge('neutral', '正在检查') : !p.has_master ? badge('warning', '缺少 master') : badge('neutral', 'master')}</label>`;
  }).join('') : '<p class="dialog-description">所有已登记项目均已关联此任务，可先登记新项目。</p>';
  updateRequirementProjectsPreview();
}

function updateRequirementProjectsPreview() {
  const q = state.requirements.find(q => q.id === requirementProjectsID);
  if (!q) return;
  const selected = [...$('#requirementProjectPicker').querySelectorAll('input:checked:not(:disabled)')].map(i => state.projects.find(p => p.id === i.value)).filter(Boolean);
  $('#requirementProjectsPreview').textContent = q.path + '/\n' + (selected.length ? selected.map((p, i) => `${i === selected.length - 1 ? '└─' : '├─'} ${p.folder}/`).join('\n') : '请选择要添加的项目');
  $('#requirementProjectsSubmit').disabled = !selected.length || q.members.length + selected.length > 30 || q.state === 'archived' || q.state === 'creating';
}

$('#registerRequirementProject').addEventListener('click', () => openProject(id => refreshRequirementProjectPicker(id)));
$('#requirementProjectPicker').addEventListener('change', updateRequirementProjectsPreview);
$('#requirementProjectsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || $('#requirementProjectsSubmit').disabled) return;
  const id = requirementProjectsID;
  const project_ids = [...$('#requirementProjectPicker').querySelectorAll('input:checked:not(:disabled)')].map(i => i.value);
  $('#requirementProjectsSubmit').disabled = true;
  try {
    await mutation('正在添加项目并创建 Worktree', async () => {
      const q = await api(`/api/requirements/${encodeURIComponent(id)}/projects`, { method: 'POST', body: JSON.stringify({ project_ids }) });
      state.requirements = state.requirements.map(current => current.id === id ? q : current);
      $('#requirementProjectsDialog').close();
      toast(q.state === 'ready' ? '项目已添加，全部项目已就绪' : '项目已关联，仍有未就绪项目，可重试失败项', q.state !== 'ready');
    }, $('#requirementProjectsError'));
  } finally { updateRequirementProjectsPreview(); }
});
