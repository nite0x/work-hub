'use strict';
let gitState = null;
let gitSelectedPath = '';
async function openGit(id, path = '') {
  if (state.busy) return;
  gitState = null;
  gitSelectedPath = path;
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
function sourceOptions(v, includeHead = true) {
  const options = ['<option value="">请选择来源分支</option>'];
  const remote = v.branches.filter(b => b.kind === 'remote');
  const local = v.branches.filter(b => b.kind === 'local');
  for (const [label, branches] of [['远端分支', remote], ['本地分支', local]]) {
    if (branches.length) options.push(`<optgroup label="${label}">${branches.map(b => `<option value="${esc(b.ref)}">${esc(b.name)} · ${esc(b.commit.slice(0, 8))}</option>`).join('')}</optgroup>`);
  }
  if (includeHead) options.push(`<option value="HEAD">当前 HEAD（${esc(v.current || 'detached')}，请明确确认基线）</option>`);
  return options.join('');
}
function renderGit() {
  const v = gitState;
  const local = v.branches.filter(b => b.kind === 'local');
  const remote = v.branches.filter(b => b.kind === 'remote');
  $('#gitTitle').textContent = 'Git 操作 · ' + v.project.name;
  const rows = v.branches.map(b => `<tr><td>${branch(b.name)} ${b.kind === 'remote' ? badge('neutral', '远端') : badge('primary-tag', '本地')}<div class="comparison">${esc(b.commit.slice(0, 8))}${b.upstream ? ' · 跟踪 ' + esc(b.upstream) : ''}</div></td><td>${b.worktrees.length ? b.worktrees.map(p => `<div class="path">${esc(p)}</div>`).join('') : '<span class="quiet">未检出</span>'}</td><td><button type="button" class="button small secondary" data-action="git-use-source" data-ref="${esc(b.ref)}">以此创建分支</button></td></tr>`).join('');
  $('#gitContent').innerHTML = `
    <p class="dialog-description git-repo-path">${esc(v.project.path)}</p>
    <div class="banner ${v.project.has_master ? 'success' : 'note'} git-master-hint">${esc(v.master_hint)}${!v.project.has_master && v.master_source ? '<button type="button" class="button small primary" data-action="git-prepare-master">从远端创建本地 master</button>' : ''}</div>
    <section class="git-section"><div class="git-section-title"><h3>远端仓库</h3><span>获取分支不会切换当前工作目录</span></div>
      <div class="git-inline"><label class="field grow">远端<select id="gitRemote" ${v.remotes.length ? '' : 'disabled'}>${v.remotes.length ? v.remotes.map(r => `<option value="${esc(r.name)}">${esc(r.name)} · ${esc(r.url)}</option>`).join('') : '<option value="">未配置远端</option>'}</select></label><button type="button" class="button primary" data-action="git-fetch" ${v.remotes.length ? '' : 'disabled'}>↓ 获取远端全部分支</button><button type="button" class="button secondary" data-action="git-fetch-terminal" ${v.remotes.length ? '' : 'disabled'}>在终端获取 ↗</button><button type="button" class="button secondary" data-action="git-reload">刷新列表</button></div>
      <div class="git-credentials" role="status">${v.credentials?.available ? '✓ ' : ''}${esc(v.credentials?.message || '使用现有 Git 凭证助手配置')}</div>
    </section>
    <section class="git-section"><div class="git-section-title"><h3>工作目录操作</h3><span>在选中的 worktree 执行</span></div>
      <label class="field">工作目录<select id="gitWorktree">${v.project.worktrees.filter(t => !t.bare && !t.missing && !t.prunable && !t.error).map(t => `<option value="${esc(t.path)}">${esc(t.path)} · ${esc(t.branch || 'detached')} · ${t.dirty ? t.dirty + ' 项修改' : '干净'}</option>`).join('')}</select></label>
      <div class="git-inline"><label class="field grow">切换到本地分支<select id="gitSwitch"></select></label><button type="button" class="button secondary" data-action="git-switch">切换分支</button><button type="button" class="button secondary" data-action="git-pull">快进拉取</button><button type="button" class="button subtle" data-action="git-terminal">打开 Git 终端 ↗</button></div>
      <small class="git-help">有未提交修改时会拒绝切换和拉取；快进拉取不会自动合并分歧提交。</small>
    </section>
    <section class="git-section"><div class="git-section-title"><h3>创建本地分支</h3><span>创建后保留当前目录的分支</span></div>
      <form id="gitCreateForm"><div class="form-grid"><label class="field">新分支名称<input id="gitBranchName" required maxlength="160" placeholder="master 或 feature/example" value="${v.project.has_master ? '' : 'master'}"></label><label class="field">来源分支<select id="gitBranchSource" required>${sourceOptions(v)}</select></label></div>
      <div class="git-inline"><label class="git-track"><input type="checkbox" id="gitTrack">设置远端跟踪关系</label><button type="submit" class="button primary">创建本地分支</button></div><div class="git-source-explanation" id="gitSourceExplanation">请选择明确的来源。创建任务统一使用本地 master 作为基线。</div></form>
    </section>
    ${local.some(b => b.worktrees.length === 0) && remote.length ? `<section class="git-section"><div class="git-section-title"><h3>更新未检出的本地分支</h3><span>适用于 master 在其他分支工作时的更新</span></div><div class="form-grid"><label class="field">本地分支<select id="gitFFLocal">${local.filter(b => b.worktrees.length === 0).map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}</select></label><label class="field">快进到远端分支<select id="gitFFSource">${remote.map(b => `<option value="${esc(b.ref)}">${esc(b.name)}</option>`).join('')}</select></label></div><button type="button" class="button secondary" data-action="git-fast-forward">快进更新本地分支</button><small class="git-help">只允许快进；分支有分歧或已被 worktree 检出时会拒绝更新。</small></section>` : ''}
    <section class="git-section"><div class="git-section-title"><h3>全部分支</h3><span>${local.length} 个本地 · ${remote.length} 个远端</span></div><div class="table-scroll"><table><thead><tr><th>分支 / 提交 / 跟踪</th><th>占用的 Worktree</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">尚无分支记录，请先获取远端或在终端创建初始提交。</td></tr>'}</tbody></table></div></section>`;
  $('#gitWorktree').value = gitSelectedPath;
  if (!$('#gitWorktree').value) {
    $('#gitWorktree').insertAdjacentHTML('afterbegin', '<option value="">原工作目录不可用，请明确选择其他目录</option>');
    $('#gitWorktree').value = '';
  }
  if (v.master_source) $('#gitBranchSource').value = v.master_source;
  updateGitSource(); updateGitWorktree();
  if ($('#gitFFLocal') && local.some(b => b.name === 'master' && !b.worktrees.length)) $('#gitFFLocal').value = 'master';
  if ($('#gitFFSource') && v.master_source) $('#gitFFSource').value = v.master_source;
}
function updateGitSource() {
  const ref = $('#gitBranchSource').value;
  const remote = ref.startsWith('refs/remotes/');
  $('#gitTrack').checked = remote; $('#gitTrack').disabled = !remote;
  $('#gitSourceExplanation').textContent = ref === 'HEAD'
    ? '当前 HEAD 的提交会成为新分支起点。这不会从远端取得 master；请确认当前代码确实是需要的基线。'
    : ref ? `新分支将从 ${ref.replace(/^refs\/(heads|remotes)\//, '')} 创建，当前工作目录保持原分支。` : '请选择明确的来源。创建任务统一使用本地 master 作为基线。';
}
function updateGitWorktree() {
  const path = $('#gitWorktree').value;
  if (path) gitSelectedPath = path;
  const t = gitState.project.worktrees.find(t => t.path === path);
  for (const action of ['git-switch', 'git-pull', 'git-terminal']) {
    $(`[data-action="${action}"]`, $('#gitContent')).disabled = !t;
  }
  $('#gitSwitch').innerHTML = gitState.branches.filter(b => b.kind === 'local').map(b => `<option value="${esc(b.ref)}" ${b.worktrees.some(p => p !== gitSelectedPath) ? 'disabled' : ''}>${esc(b.name)}${b.worktrees.some(p => p !== gitSelectedPath) ? '（其他 worktree 占用）' : ''}</option>`).join('');
  if (t?.branch) $('#gitSwitch').value = 'refs/heads/' + t.branch;
}
async function gitOperation(body, title) {
  if (!gitState || state.busy) return;
  const id = gitState.project.id;
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
    let result;
    try {
      result = await api(`/api/projects/${id}/git`, { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      $('#gitAuthHelp').hidden = !(body.action === 'fetch' && error.code === 'authentication_required');
      throw error;
    }
    $('#gitResultTitle').textContent = result.message;
    $('#gitOutput').textContent = result.output || '';
    $('#gitResult').hidden = false;
    gitState = await api(`/api/projects/${id}/git`);
    renderGit();
  }, $('#gitError')); } finally {
    clearInterval(timer);
    $('#gitProgress').hidden = true;
    if (!$('#gitError').hidden) { $('#gitResult').hidden = true; $('#gitError').scrollIntoView({ block: 'nearest' }); }
    else $('#gitResult').scrollIntoView({ block: 'nearest' });
    buttons.forEach(([button, disabled]) => { if (button.isConnected) button.disabled = disabled; });
  }
}
document.addEventListener('submit', event => {
  if (event.target.id !== 'gitCreateForm') return;
  event.preventDefault();
  gitOperation({ action: 'create_branch', name: $('#gitBranchName').value, source: $('#gitBranchSource').value, track: $('#gitTrack').checked }, '正在创建本地分支');
});
document.addEventListener('change', event => {
  if (event.target.id === 'gitBranchSource') updateGitSource();
  if (event.target.id === 'gitWorktree') updateGitWorktree();
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action^="git-"]');
  if (!button || state.busy) return;
  const action = button.dataset.action;
  if (action === 'git-open') return openGit(button.dataset.id, button.dataset.path);
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
  if (action === 'git-switch') return gitOperation({ action: 'switch', source: $('#gitSwitch').value, path: $('#gitWorktree').value }, '正在切换工作目录分支');
  if (action === 'git-pull') return gitOperation({ action: 'pull', path: $('#gitWorktree').value }, '正在快进拉取当前分支');
  if (action === 'git-terminal') return gitOperation({ action: 'terminal', path: $('#gitWorktree').value }, '正在打开 Git 终端');
  if (action === 'git-fast-forward') return gitOperation({ action: 'fast_forward', name: $('#gitFFLocal').value, source: $('#gitFFSource').value }, '正在快进更新本地分支');
});
