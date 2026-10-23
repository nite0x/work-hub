'use strict';
let gitState = null;
let gitSelectedPath = '';
let gitRequirementID = '';
let gitMergePreviewData = null;
const mergeAIRequests = new Map();
let gitAILaunching = false;
async function openGit(id, path = '', requirement = '') {
  if (state.busy || gitAILaunching) return;
  gitState = null;
  gitSelectedPath = path;
  gitRequirementID = requirement;
  gitMergePreviewData = null;
  $('#gitError').hidden = true;
  $('#gitAuthHelp').hidden = true;
  $('#gitResult').hidden = true;
  $('#gitContent').innerHTML = '<div class="loading">正在读取分支与远端…</div>';
  $('#gitDialog').showModal();
  try {
    const overview = await api(`/api/projects/${id}/git`);
    if (path && !overview.project.worktrees.some(t => t.path === path && !t.bare && !t.missing && !t.prunable && !t.error)) {
      throw new Error('该任务的工作目录已不可用，请关闭面板并刷新任务状态。');
    }
    gitState = overview;
    gitSelectedPath = path || gitState.project.path;
    renderGit();
  } catch (error) { $('#gitContent').textContent = ''; $('#gitError').textContent = error.message; $('#gitError').hidden = false; }
}
function defaultBranchSource(v) {
  return ['refs/heads/master', 'refs/heads/main', 'refs/remotes/origin/master', 'refs/remotes/origin/main'].find(ref => v.branches.some(b => b.ref === ref)) || 'HEAD';
}
function sourceOptions(v, includeHead = true) {
  return window.WorkHubUI.sourceOptions(v, includeHead);
}
function renderGit() {
  const v = gitState;
  const local = v.branches.filter(b => b.kind === 'local');
  $('#gitTitle').textContent = 'Git 操作 · ' + v.project.name;
  $('#gitContent').innerHTML = window.WorkHubUI.git(v);
  $('#gitWorktree').value = gitSelectedPath;
  $('#gitWorktree').disabled = !!gitRequirementID;
  if (!$('#gitWorktree').value) {
    $('#gitWorktree').insertAdjacentHTML('afterbegin', '<option value="">原工作目录不可用，请明确选择其他目录</option>');
    $('#gitWorktree').value = '';
  }
  $('#gitBranchSource').value = defaultBranchSource(v);
  updateGitSource(); updateGitWorktree();
  if ($('#gitFFLocal') && local.some(b => b.name === 'master' && !b.worktrees.length)) $('#gitFFLocal').value = 'master';
  if ($('#gitFFSource') && v.master_source) $('#gitFFSource').value = v.master_source;
}
function updateGitSource() {
  const ref = $('#gitBranchSource').value;
  const remote = ref.startsWith('refs/remotes/');
  $('#gitTrack').checked = remote; $('#gitTrack').disabled = !remote;
  $('#gitSourceExplanation').textContent = ref === 'HEAD'
    ? '当前 HEAD 的提交会成为新分支起点。'
    : ref ? `新分支将从 ${ref.replace(/^refs\/(heads|remotes)\//, '')} 创建，当前工作目录保持原分支。` : '请选择来源分支。';
}
function updateGitWorktree() {
  const path = $('#gitWorktree').value;
  if (path) gitSelectedPath = path;
  const t = gitState.project.worktrees.find(t => t.path === path);
  $('#gitBranchSource option[value="HEAD"]').textContent = `所选工作目录 HEAD（${t?.branch || 'detached'}）`;
  const unavailable = !t || !!t.operation;
  for (const action of ['git-switch', 'git-pull', 'git-push', 'git-merge-preview']) {
    $(`[data-action="${action}"]`, $('#gitContent')).disabled = unavailable || (action !== 'git-push' && !!t?.dirty) || (action !== 'git-switch' && !!t?.detached);
  }
  $('[data-action="git-terminal"]').disabled = !t;
  $('#gitContext').textContent = `${environmentName()} · ${gitState.project.name}\n${path}\n当前分支：${t?.branch || 'detached HEAD'}\n${!t?.upstream ? '尚未设置上游' : !t.sync_available ? `上游 ${t.upstream} 不可用，请获取远端` : `上游 ${t.upstream} · 待推送 ${t.sync_ahead || 0} · 待拉取 ${t.sync_behind || 0}`}${t?.dirty ? `\n${t.dirty} 项未提交修改（推送只发送已提交内容）` : ''}`;
  $('#gitSwitch').innerHTML = gitState.branches.map(b => `<option value="${esc(b.ref)}" ${b.worktrees.some(p => p !== gitSelectedPath) ? 'disabled' : ''}>${esc(b.name)}${b.kind === 'remote' ? '（新建跟踪分支）' : ''}${b.worktrees.some(p => p !== gitSelectedPath) ? '（其他 worktree 占用）' : ''}</option>`).join('');
  if (t?.branch) $('#gitSwitch').value = 'refs/heads/' + t.branch;
  $('#gitSwitchNote').textContent = gitRequirementID ? '切换后同步更新当前任务的关联分支，创建基线保留。' : '切换作用于所选目录；关联任务会显示分支变化。';
  updateGitSwitch();
  const remotes = [...gitState.remotes].sort((a, b) => b.name.length - a.name.length);
  const upstreamRemote = remotes.find(r => t?.upstream?.startsWith(r.name + '/'));
  $('#gitPushRemote').value = upstreamRemote?.name || remotes.find(r => r.name === 'origin')?.name || remotes[0]?.name || '';
  $('#gitPushName').value = upstreamRemote ? t.upstream.slice(upstreamRemote.name.length + 1) : t?.branch || '';
  $('#gitPushTrack').checked = !t?.upstream;
  updateGitPush();
  $('#gitMergeActive').hidden = t?.operation !== 'merge';
  $('#gitMergeForm').hidden = t?.operation === 'merge';
  $('#gitMergeStatus').textContent = t?.operation === 'merge' ? `合并进行中${t.conflicts?.length ? `，${t.conflicts.length} 个冲突文件：\n${t.conflicts.join('\n')}` : '，等待完成合并提交'}\n${gitRequirementID ? '可交给 AI 继续完成合并。' : '请从关联任务进入以使用 AI 处理。'}` : '';
  $('[data-action="git-merge-ai"]').disabled = !gitRequirementID && t?.requirements?.length !== 1;
  const upstream = gitState.branches.find(b => b.kind === 'remote' && b.name === t?.upstream);
  $('#gitMergeSource').value = upstream?.ref || '';
  clearGitMergePreview();
}
function updateGitSwitch() {
  const b = gitState?.branches.find(b => b.ref === $('#gitSwitch').value);
  $('#gitSwitchName').closest('.field').hidden = b?.kind !== 'remote';
  if (b?.kind === 'remote') {
    const remote = [...gitState.remotes].sort((a, b) => b.name.length - a.name.length).find(r => b.name.startsWith(r.name + '/'));
    $('#gitSwitchName').value = remote ? b.name.slice(remote.name.length + 1) : '';
  }
}
function updateGitPush() {
  const t = gitState?.project.worktrees.find(t => t.path === gitSelectedPath);
  $('#gitPushDirection').textContent = `${t?.branch || 'detached HEAD'} → ${$('#gitPushRemote').value}/${$('#gitPushName').value}`;
  $('[data-action="git-push"]').disabled = !t || !!t.detached || !!t.operation || !$('#gitPushRemote').value || !$('#gitPushName').value.trim();
}
function clearGitMergePreview() {
  gitMergePreviewData = null;
  $('#gitMergePreview').hidden = true;
  $('[data-action="git-merge"]').disabled = true;
}

async function launchGitMergeAI() {
  if (gitAILaunching) return;
  const t = gitState?.project.worktrees.find(t => t.path === gitSelectedPath);
  const requirement = gitRequirementID || (t?.requirements?.length === 1 ? t.requirements[0].id : '');
  if (!t?.merge_head || !requirement) throw new Error('请从关联任务进入合并目录后再打开 AI。');
  const project = gitState.project.id;
  gitAILaunching = true;
  const controls = [...$('#gitDialog').querySelectorAll('button, input, select')].map(control => [control, control.disabled]);
  controls.forEach(([control]) => { control.disabled = true; });
  try {
  const environment = activeEnvironment, revision = environmentRevision;
  const key = [environment, requirement, project, t.path, t.head, t.merge_head].join(':');
  let pending = mergeAIRequests.get(key);
  if (!pending) {
    pending = { request_id: crypto.randomUUID() };
    mergeAIRequests.set(key, pending);
  }
  if (!pending.promise) {
    const body = { request_id: pending.request_id, project_id: project, merge_head: t.merge_head };
    const route = sessionReadOnly ? 'merge-ai' : 'sessions/new';
    if (!sessionReadOnly) body.purpose = 'merge_conflict';
    pending.promise = api(`/api/requirements/${encodeURIComponent(requirement)}/${route}`, { method: 'POST', body: JSON.stringify(body), environment });
  }
  let result;
  try { result = await pending.promise; }
  catch (error) { delete pending.promise; throw error; }
  if (revision !== environmentRevision) return;
  if (result.session) {
    const cached = requirementSessions.get(requirement) || { sessions: [] };
    cached.sessions = [result.session, ...cached.sessions.filter(s => s.id !== result.session.id)];
    requirementSessions.set(requirement, cached);
    updateRequirementSessionsView(requirement);
    $('#gitDialog').close();
    openSessionHistory(requirement, result.session.id);
    if (!sessionHistoryState.assistant) {
      sessionHistoryState.newlyCreated = true;
      applyChatState(sessionHistoryState, result.chat);
      if (result.chat.busy) streamChat(sessionHistoryState, result.chat.id);
    }
    toast('合并出现冲突，AI 已开始处理，请在会话中查看进展。');
  } else {
    $('#gitResultTitle').textContent = result.message;
    $('#gitResult').hidden = false;
    toast(result.message);
  }
  } finally {
    gitAILaunching = false;
    controls.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
  }
}
async function gitOperation(body, title) {
  if (!gitState || state.busy) return;
  const id = gitState.project.id;
  const scopedActions = ['switch', 'adopt_branch', 'pull', 'push', 'merge_preview', 'merge', 'merge_abort'];
  if (scopedActions.includes(body.action)) {
    body.path ||= gitSelectedPath;
    const t = gitState.project.worktrees.find(t => t.path === body.path);
    if (gitRequirementID) body.requirement_id = gitRequirementID;
    if (t?.branch) body.expected_branch = t.branch;
  }
  let result;
  $('#gitAuthHelp').hidden = true;
  $('#gitProgress').textContent = title + '，请稍候…';
  $('#gitProgress').hidden = false;
  const buttons = [...$('#gitDialog').querySelectorAll('button')].map(button => [button, button.disabled]);
  buttons.forEach(([button]) => { button.disabled = true; });
  $('#gitResultTitle').textContent = title + '，请稍候…';
  $('#gitOutput').textContent = '';
  $('#gitResult').hidden = false;
  $('#gitProgress').scrollIntoView({ block: 'nearest' });
  const started = Date.now();
  const timer = setInterval(() => {
    $('#gitProgress').textContent = title + `，已等待 ${Math.floor((Date.now() - started) / 1000)} 秒。后台操作最长等待 90 秒；需要登录时请使用终端获取。`;
  }, 1000);
  try { await mutation(title, async () => {
    try {
      result = await api(`/api/projects/${id}/git`, { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      $('#gitAuthHelp').hidden = error.code !== 'authentication_required';
      try { gitState = await api(`/api/projects/${id}/git`); renderGit(); } catch { /* Keep the last readable state and original action error. */ }
      throw error;
    }
    if (result.conflict) {
      const tree = gitState.project.worktrees.find(t => t.path === gitSelectedPath);
      if (tree) Object.assign(tree, { operation: 'merge', merge_head: result.merge_head, conflicts: result.conflicts });
    }
    $('#gitResultTitle').textContent = result.message;
    $('#gitOutput').textContent = result.output || '';
    $('#gitResult').hidden = false;
    try { gitState = await api(`/api/projects/${id}/git`); renderGit(); }
    catch (error) { renderGit(); throw new Error('操作已执行，但状态刷新失败，请刷新检查后再操作：' + error.message); }
  }, $('#gitError')); } finally {
    clearInterval(timer);
    $('#gitProgress').hidden = true;
    if (!$('#gitError').hidden) { $('#gitResult').hidden = true; $('#gitError').scrollIntoView({ block: 'nearest' }); }
    else $('#gitResult').scrollIntoView({ block: 'nearest' });
    buttons.forEach(([button, disabled]) => { if (button.isConnected) button.disabled = disabled; });
  }
  if (result?.conflict) {
    toast(`合并出现冲突（${result.conflicts.length} 个文件），正在打开 AI…`, true);
    try { await launchGitMergeAI(); }
    catch (error) {
      $('#gitError').textContent = '冲突已保留，AI 启动未完成：' + error.message;
      $('#gitError').hidden = false;
      if (error.command) showCommand(error.command);
    }
  }
  return result;
}

async function pushGitBranch() {
  const t = gitState.project.worktrees.find(t => t.path === gitSelectedPath);
  const remote = $('#gitPushRemote').value, name = $('#gitPushName').value.trim();
  if (!remote || !name || !t) return;
  if (!confirm(`推送 ${t.branch} → ${remote}/${name}\n工作目录：${t.path}\n${t.dirty ? '只推送已提交内容，未提交修改保留。' : ''}`)) return;
  return gitOperation({ action: 'push', remote, name, track: $('#gitPushTrack').checked }, '正在推送当前分支');
}
document.addEventListener('submit', event => {
  if (event.target.id !== 'gitCreateForm') return;
  event.preventDefault();
  const body = { action: 'create_branch', name: $('#gitBranchName').value, source: $('#gitBranchSource').value, track: $('#gitTrack').checked };
  if (body.source === 'HEAD') { body.path = gitSelectedPath; if (gitRequirementID) body.requirement_id = gitRequirementID; }
  gitOperation(body, '正在创建本地分支');
});
document.addEventListener('change', event => {
  if (event.target.id === 'gitBranchSource') updateGitSource();
  if (event.target.id === 'gitWorktree') updateGitWorktree();
  if (event.target.id === 'gitSwitch') updateGitSwitch();
  if (event.target.id === 'gitPushRemote') updateGitPush();
  if (event.target.id === 'gitMergeSource') clearGitMergePreview();
});
document.addEventListener('input', event => { if (event.target.id === 'gitPushName') updateGitPush(); });
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action^="git-"]');
  if (!button || button.disabled || state.busy || gitAILaunching) return;
  const action = button.dataset.action;
  if (action === 'git-open') return openGit(button.dataset.id, button.dataset.path, button.dataset.requirement);
  if (action.startsWith('git-task-')) {
    await openGit(button.dataset.id, button.dataset.path, button.dataset.requirement);
    if (!gitState) return;
    if (action === 'git-task-pull') return gitOperation({ action: 'pull' }, '正在快进拉取');
    if (action === 'git-task-push') {
      const t = gitState.project.worktrees.find(t => t.path === gitSelectedPath);
      if (t?.upstream) return pushGitBranch();
      $('#gitPushName').focus(); return;
    }
    if (action === 'git-task-adopt') return gitOperation({ action: 'adopt_branch' }, '正在更新任务关联分支');
    if (action === 'git-task-ai') {
      try { await launchGitMergeAI(); } catch (error) { $('#gitError').textContent = error.message; $('#gitError').hidden = false; if (error.command) showCommand(error.command); }
      return;
    }
  }
  if (action === 'git-prepare-project') {
    const environment = $('#requirementEnvironment').value;
    $('#requirementDialog').close();
    await selectEnvironment(environment, '/projects');
    state.selectedProject = button.dataset.id; render(); return openGit(button.dataset.id);
  }
  if (!gitState) return;
  if (action === 'git-reload') {
    try { gitState = await api(`/api/projects/${gitState.project.id}/git`); $('#gitError').hidden = true; $('#gitAuthHelp').hidden = true; renderGit(); } catch (e) { $('#gitError').textContent = e.message; $('#gitError').hidden = false; } return;
  }
  if (action === 'git-use-source') { $('#gitBranchSource').value = button.dataset.ref; updateGitSource(); $('#gitBranchName').focus(); return; }
  if (action === 'git-fetch') return gitOperation({ action: 'fetch', remote: $('#gitRemote').value }, '正在获取远端全部分支');
  if (action === 'git-fetch-terminal') return gitOperation({ action: 'fetch_terminal', remote: $('#gitRemote').value }, '正在打开终端获取分支');
  if (action === 'git-prepare-master') return gitOperation({ action: 'create_branch', name: 'master', source: gitState.master_source, track: true }, '正在从远端创建本地 master');
  if (action === 'git-switch') {
    const t = gitState.project.worktrees.find(t => t.path === gitSelectedPath);
    const shared = (t?.requirements || []).filter(q => q.id !== gitRequirementID);
    if (shared.length && !confirm(`该目录还关联任务：${shared.map(q => q.name).join('、')}。切换会影响这些任务的实际分支，是否继续？`)) return;
    const body = { action: 'switch', source: $('#gitSwitch').value, path: $('#gitWorktree').value };
    if (body.source.startsWith('refs/remotes/')) body.name = $('#gitSwitchName').value.trim();
    if (shared.length) body.allow_shared = true;
    return gitOperation(body, '正在切换工作目录分支');
  }
  if (action === 'git-pull') return gitOperation({ action: 'pull', path: $('#gitWorktree').value }, '正在快进拉取当前分支');
  if (action === 'git-terminal') return gitOperation({ action: 'terminal', path: $('#gitWorktree').value }, '正在打开 Git 终端');
  if (action === 'git-push') return pushGitBranch();
  if (action === 'git-merge-preview') {
    const source = $('#gitMergeSource').value;
    if (!source) return;
    const result = await gitOperation({ action: 'merge_preview', source }, '正在预览合并');
    if (result) {
      $('#gitMergeSource').value = source;
      gitMergePreviewData = { source, source_commit: result.source_commit, expected_head: result.expected_head };
      $('#gitMergePreview').textContent = result.message + '\n目录：' + gitSelectedPath + '\n待合入提交（最多 20 条）：\n' + (result.output || '无新增提交');
      $('#gitMergePreview').hidden = false;
      $('[data-action="git-merge"]').disabled = false;
    }
    return;
  }
  if (action === 'git-merge' && gitMergePreviewData) return gitOperation({ action: 'merge', ...gitMergePreviewData }, '正在合并分支');
  if (action === 'git-merge-abort') {
    if (!confirm('中止当前合并？此次冲突解决过程中尚未提交的修改也可能被撤销。')) return;
    return gitOperation({ action: 'merge_abort' }, '正在中止合并');
  }
  if (action === 'git-merge-ai') {
    try { await launchGitMergeAI(); } catch (error) { $('#gitError').textContent = error.message; $('#gitError').hidden = false; if (error.command) showCommand(error.command); }
    return;
  }
  if (action === 'git-fast-forward') return gitOperation({ action: 'fast_forward', name: $('#gitFFLocal').value, source: $('#gitFFSource').value }, '正在快进更新本地分支');
});
