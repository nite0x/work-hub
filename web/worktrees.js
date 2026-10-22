'use strict';
let worktreeOverview = null;
let worktreeRequest = 0;

async function openWorktree(id) {
  if (state.busy) return;
  const request = ++worktreeRequest;
  worktreeOverview = null;
  const form = $('#worktreeForm');
  form.reset();
  delete $('#worktreeBranch').dataset.edited;
  $('#worktreeError').hidden = true;
  form.hidden = true;
  $('#worktreeLoading').hidden = false;
  $('#worktreeTitle').textContent = '创建 Worktree';
  $('#worktreeProject').textContent = state.projects.find(p => p.id === id)?.name || '';
  $('#worktreeDialog').showModal();
  try {
    const overview = await api(`/api/projects/${id}/git`);
    if (request !== worktreeRequest || !$('#worktreeDialog').open) return;
    worktreeOverview = overview;
    $('#worktreeTitle').textContent = '创建 Worktree · ' + overview.project.name;
    $('#worktreeProject').textContent = overview.project.path;
    $('#worktreeSource').innerHTML = sourceOptions(overview);
    $('#worktreeSource').value = overview.project.has_master ? 'refs/heads/master' : '';
    $('#worktreeExisting').innerHTML = '<option value="">请选择未被占用的本地分支</option>' + overview.branches.filter(b => b.kind === 'local').map(b => `<option value="${esc(b.name)}" ${b.worktrees.length ? 'disabled' : ''}>${esc(b.name)}${b.worktrees.length ? '（已被 worktree 占用）' : ''}</option>`).join('');
    form.hidden = false;
    updateWorktreePreview();
  } catch (error) {
    if (request !== worktreeRequest) return;
    $('#worktreeError').textContent = error.message;
    $('#worktreeError').hidden = false;
  } finally { if (request === worktreeRequest) $('#worktreeLoading').hidden = true; }
}

function updateWorktreePreview() {
  if (!worktreeOverview) return;
  const existing = $('#worktreeMode').value === 'existing';
  $('#worktreeNewFields').hidden = existing;
  $('#worktreeBranch').disabled = existing;
  $('#worktreeSource').disabled = existing;
  $('#worktreeExistingField').hidden = !existing;
  $('#worktreeExisting').disabled = !existing;
  const slug = $('#worktreeSlug').value.trim();
  if (!$('#worktreeBranch').dataset.edited) $('#worktreeBranch').value = slug ? 'codex/' + slug : '';
  $('#worktreePath').textContent = `${state.root}/${slug || '<工作标识>'}/${worktreeOverview.project.folder}`;
  const ref = existing ? 'refs/heads/' + $('#worktreeExisting').value : $('#worktreeSource').value;
  const selected = worktreeOverview.branches.find(b => b.ref === ref);
  $('#worktreeSourceNote').textContent = existing
    ? (selected ? `将在新目录检出已有分支 ${selected.name}（${selected.commit.slice(0, 8)}），不创建新分支。` : '请选择未被占用的本地分支。如果没有可用分支，请选择新建分支。')
    : (selected ? `新分支将从 ${selected.name}（${selected.commit.slice(0, 8)}）创建。` : ref === 'HEAD' ? '你选择了当前 HEAD 作为起点，请确认这是需要的代码基线。' : '请选择明确的来源分支。独立 worktree 可使用任意已有分支；创建任务仍使用本地 master 作为基线。');
}

$('#worktreeForm').addEventListener('input', event => {
  if (event.target.id === 'worktreeBranch') $('#worktreeBranch').dataset.edited = '1';
  updateWorktreePreview();
});
$('#worktreeForm').addEventListener('change', updateWorktreePreview);
$('#worktreeForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!worktreeOverview || state.busy) return;
  const id = worktreeOverview.project.id;
  const mode = $('#worktreeMode').value;
  const body = { slug: $('#worktreeSlug').value, mode, branch: mode === 'new' ? $('#worktreeBranch').value : $('#worktreeExisting').value, source: mode === 'new' ? $('#worktreeSource').value : '' };
  $('#worktreeSubmit').disabled = true;
  try {
    await mutation('正在创建独立 Worktree', async () => {
      const result = await api(`/api/projects/${id}/worktrees`, { method: 'POST', body: JSON.stringify(body) });
      state.selectedProject = id; navigate('/projects'); $('#search').value = '';
      $('#worktreeDialog').close();
      toast(`${result.message} · ${result.branch}`);
    }, $('#worktreeError'));
  } finally { $('#worktreeSubmit').disabled = false; }
});
