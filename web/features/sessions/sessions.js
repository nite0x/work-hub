'use strict';
const requirementSessions = new Map();
let sessionPickerRequirement = null;
let sessionPickerCursor = null;
let sessionPickerLoading = false;
let sessionPickerGeneration = 0;
let sessionPickerSearch = '';
let sessionPickerItems = [];

function sessionTime(value) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '暂无活动记录';
}

function renderRequirementSessions(q) {
  const data = requirementSessions.get(q.id);
  const readonly = typeof sessionReadOnly !== 'undefined' && sessionReadOnly;
  const rows = (data?.sessions || []).map(s => `<tr><td><strong>${esc(s.name)}</strong><div class="path">${esc(s.id)}</div></td><td><div class="path">${esc(s.cwd)}</div>${q.members.some(m => m.path === s.cwd) || s.cwd === q.path ? '' : '<div class="table-message">任务工作目录之外的会话</div>'}</td><td>${esc(sessionTime(s.updated_at))}<div class="comparison">${s.source === 'manual' ? '手动关联' : '自动关联'}</div>${s.error ? `<div class="table-message">${esc(s.error)}</div>` : ''}</td><td><div class="session-row-actions"><button type="button" class="button small secondary" data-session-action="details" data-session="${esc(s.id)}" data-requirement="${esc(q.id)}">查看详情</button><button type="button" class="button small primary" data-session-action="resume" data-session="${esc(s.id)}" data-requirement="${esc(q.id)}" ${s.available && q.state === 'ready' ? '' : 'disabled'}>继续会话 ↗</button></div></td></tr>`).join('');
  const description = readonly ? '在终端中对话，在这里查看已保存的会话内容。任务工作区及各项目根目录中的会话会自动关联。' : '新建会话直接在侧栏开始并自动关联任务。直接在工作区总目录或项目工作目录启动的本地会话也会自动关联。';
  const newButton = readonly ? `<button type="button" class="button small primary" data-action="launch" data-id="${esc(q.id)}" ${q.state === 'ready' ? '' : 'disabled'}>在终端新建会话 ↗</button>` : `<button type="button" class="button small primary" data-session-action="new" data-requirement="${esc(q.id)}" ${q.state === 'ready' ? '' : 'disabled'}>＋ 新建会话</button>`;
  const footer = readonly ? '会话列表每 10 秒刷新；详情手动刷新显示已保存的消息和执行记录。' : '会话列表每 10 秒刷新。工作台新打开的终端支持在详情中一键切换到侧栏；运行中的一轮会先完成，无法确认归属的手动终端会阻止接管。';
  return `<section id="requirementSessions" class="requirement-sessions" aria-labelledby="sessionsTitle"><div class="detail-top"><div><h2 id="sessionsTitle">关联会话 ${data ? badge('neutral', String(data.sessions.length)) : ''}</h2><p class="session-description">${description}</p></div><div class="detail-actions">${newButton}<button type="button" class="button small secondary" data-session-action="refresh" data-requirement="${esc(q.id)}">刷新会话</button><button type="button" class="button small secondary" data-session-action="picker" data-requirement="${esc(q.id)}">＋ 关联已有会话</button></div></div>${data?.error ? `<div class="form-error" role="alert">${esc(data.error)} <span>可点击“刷新会话”重试。</span></div>` : ''}${rows ? `<div class="table-scroll"><table><thead><tr><th>会话</th><th>继续时的工作目录</th><th>最近活动 / 来源</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="session-empty" role="status">${!data || data.loading ? '正在读取 Codex 会话…' : data.error ? '暂时无法读取会话。' : '暂无关联会话。可在终端新建会话，或关联已有会话。'}</p>`}<p class="session-description">${footer}</p></section>`;
}

function updateRequirementSessionsView(id) {
  if (state.selectedRequirement !== id || state.view !== 'requirements') return;
  const q = state.requirements.find(q => q.id === id);
  const container = $('#requirementSessions');
  if (q && container) container.outerHTML = renderRequirementSessions(q);
}

async function refreshRequirementSessions(id, force = true) {
  const previous = requirementSessions.get(id);
  if (previous?.loading) return;
  if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < 10000) return;
  const data = { sessions: previous?.sessions || [], loading: true, error: '', checkedAt: Date.now() };
  requirementSessions.set(id, data);
  try {
    const result = await api(`/api/requirements/${encodeURIComponent(id)}/sessions`);
    data.sessions = result.sessions;
    data.error = result.error || '';
  } catch (error) { data.error = error.message; }
  finally { data.loading = false; updateRequirementSessionsView(id); }
}

function renderSessionPicker() {
  const linked = new Set((requirementSessions.get(sessionPickerRequirement)?.sessions || []).map(s => s.id));
  $('#sessionPickerResults').innerHTML = sessionPickerItems.length ? sessionPickerItems.map(s => `<div class="session-picker-row"><div><strong>${esc(s.name)}</strong><div class="path">${esc(s.cwd)}</div><small>${esc(sessionTime(s.updatedAt))} · ${esc(s.id)}</small></div><button type="button" class="button small secondary" data-session-action="link" data-session="${esc(s.id)}" ${linked.has(s.id) ? 'disabled' : ''}>${linked.has(s.id) ? '已关联' : '关联'}</button></div>`).join('') : '<p class="session-empty">没有找到会话。可换一个标题搜索，或填写会话 ID。</p>';
  $('#sessionPickerMore').hidden = !sessionPickerCursor;
}

async function loadSessionPicker(more = false) {
  if (sessionPickerLoading) return;
  sessionPickerLoading = true;
  const generation = sessionPickerGeneration;
  $('#sessionPickerError').hidden = true;
  $('#sessionPickerMore').disabled = true;
  if (!more) { sessionPickerItems = []; $('#sessionPickerResults').textContent = '正在读取本地会话…'; }
  const params = new URLSearchParams();
  if (more && sessionPickerCursor) params.set('cursor', sessionPickerCursor);
  if (sessionPickerSearch) params.set('search', sessionPickerSearch);
  try {
    const page = await api('/api/codex/sessions?' + params);
    if (generation !== sessionPickerGeneration) return;
    const byID = new Map((more ? sessionPickerItems : []).map(s => [s.id, s]));
    page.data.forEach(s => byID.set(s.id, s));
    sessionPickerItems = [...byID.values()];
    sessionPickerCursor = page.nextCursor;
    renderSessionPicker();
  } catch (error) {
    if (generation !== sessionPickerGeneration) return;
    $('#sessionPickerResults').textContent = '';
    $('#sessionPickerError').textContent = error.message;
    $('#sessionPickerError').hidden = false;
  } finally { sessionPickerLoading = false; $('#sessionPickerMore').disabled = false; }
}

async function linkPickedSession(id) {
  const requirement = sessionPickerRequirement;
  await mutation('正在关联会话', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(requirement)}/sessions`, { method: 'POST', body: JSON.stringify({ session_id: id }) });
    await refreshRequirementSessions(requirement);
    $('#sessionDialog').close();
    toast(result.message);
  }, $('#sessionPickerError'));
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-session-action]');
  if (!target || target.disabled || state.busy) return;
  const action = target.dataset.sessionAction;
  const id = target.dataset.requirement;
  if (action === 'refresh') return refreshRequirementSessions(id);
  if (action === 'picker') {
    if (sessionPickerLoading) return;
    sessionPickerRequirement = id;
    sessionPickerGeneration++;
    sessionPickerCursor = null;
    sessionPickerSearch = '';
    $('#sessionSearchForm').reset(); $('#sessionLinkForm').reset();
    $('#sessionPickerMore').hidden = true;
    $('#sessionDialog').showModal();
    return loadSessionPicker();
  }
  if (action === 'link') return linkPickedSession(target.dataset.session);
  if (action === 'resume') return mutation('正在打开会话终端', async () => {
    const result = await api(`/api/requirements/${encodeURIComponent(id)}/sessions/${encodeURIComponent(target.dataset.session)}/resume`, { method: 'POST', body: '{}' });
    toast(result.message);
  });
});
$('#sessionSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  if (sessionPickerLoading) return;
  sessionPickerSearch = event.target.elements.search.value.trim();
  sessionPickerCursor = null;
  loadSessionPicker();
});
$('#sessionLinkForm').addEventListener('submit', event => {
  event.preventDefault(); linkPickedSession(event.target.elements.session_id.value.trim());
});
$('#sessionPickerMore').addEventListener('click', () => loadSessionPicker(true));
