'use strict';

// Each tab retains its own existing controllers and DOM. Only navigation
// metadata crosses the host boundary; repositories and runs stay server-owned.
(() => {
  if (!window.parent || window.parent === window) return;
  const host = window.parent;
  let active = false, restoring = true, timer, disposed = false;
  document.documentElement.setAttribute('data-workspace-tab', '');
  const post = (type, detail = {}) => host.postMessage({type, ...detail}, location.origin);
  let chromeSignature = '';
  function publishChrome() {
    if (!active || disposed) return;
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const box = sidebar.getBoundingClientRect();
    const compact = window.innerWidth <= 760;
    const chrome = {left:compact ? 0 : Math.round(box.right), top:compact ? Math.round(box.bottom) : 0};
    const signature = JSON.stringify(chrome);
    if (signature !== chromeSignature) {chromeSignature = signature; post('workhub:tab-chrome', {chrome});}
  }
  function snapshot() {
    const route = location.hash.slice(1) || '/requirements';
    const view = state.view === 'sessions' ? conversationView : null;
    const session = view?.sessions.find(item => conversationSessionKey(item) === view.selected);
    const project = state.projects.find(item => item.id === state.selectedProject);
    const task = state.requirements.find(item => item.id === state.selectedRequirement);
    const title = view ? session?.name || conversationScopeName(view.scope) : state.view === 'projects' && projectDetailOpen ? project?.name || '项目' : state.view === 'settings' ? '设置' : state.view === 'projects' ? '项目' : task?.name || '任务';
    return {
      route, environment: activeEnvironment, title, kind: state.view,
      context: view ? conversationScopeName(view.scope) : '',
      project: {id:state.selectedProject, detail:projectDetailOpen, filter:projectFilter},
      taskList: {...taskListMemory, focus:null},
      search: $('#search').value,
      conversation: view ? {scope:view.scope, selected:view.selected, search:view.search, directory:view.directory, statusFilter:view.statusFilter, environmentFilter:view.environmentFilter, archived:view.archived, pane:view.pane, scrollTop:$('#sessionBrowserList').scrollTop} : null,
    };
  }
  function publish() {
    if (!restoring && !disposed) post('workhub:tab-state', {snapshot:snapshot()});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(publish, 100); }
  function layout(height) {
    if (height !== 0 && height !== 40) return;
    const root = document.documentElement;
    if (root.style.getPropertyValue('--workspace-tab-height') === height + 'px') return;
    window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{phase:'before'}}));
    root.style.setProperty('--workspace-tab-height', height + 'px');
    root.toggleAttribute('data-workspace-tabs-visible', height > 0);
    window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{visible:active}}));
  }
  function visibility(visible) {
    if (!visible) window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{phase:'before'}}));
    active = visible;
    document.documentElement.toggleAttribute('data-workspace-inactive', !active);
    if (active) {
      chromeSignature = ''; publishChrome(); requestAnimationFrame(publishChrome);
      window.dispatchEvent(new CustomEvent('workhub:chat-layout', {detail:{visible:true}}));
      if (!restoring) { refresh(); if (conversationView && conversationVisible()) showConversationSelection(); }
    }
  }
  async function restore(saved) {
    restoring = true;
    try {
      if (saved.taskList) { taskListMounted = false; Object.assign(taskListMemory, saved.taskList); restoreTaskListControls(); }
      await selectEnvironment(saved.environment || 'local', saved.route || '/requirements', 'replace');
      if (disposed) return;
      if (state.view === 'projects' && saved.project) {
        state.selectedProject = saved.project.id;
        projectDetailOpen = !!saved.project.detail;
        projectFilter = ['all','dirty','error'].includes(saved.project.filter) ? saved.project.filter : 'all';
        $('#search').value = saved.search || ''; render();
      }
      if (state.view === 'sessions' && saved.conversation?.scope) {
        const savedView = saved.conversation;
        rememberConversationView(); closeSessionHistory(false);
        conversationView = conversationViewFor(savedView.scope);
        Object.assign(conversationView, {
          search:savedView.search || '', directory:savedView.directory || '',
          statusFilter:savedView.statusFilter || 'all', environmentFilter:savedView.environmentFilter || '',
          archived:!!savedView.archived, selected:savedView.selected, requestedSession:savedView.selected || null,
          pane:savedView.pane || 'detail', creating:false, target:null,
          requestID:(conversationView.requestID || 0) + 1, requestKey:null, loading:false, checkedAt:0,
        });
        conversationPageScopes.set(activeEnvironment, savedView.scope);
        renderConversationBrowser(); await refreshSessionWorkspace(true);
        if (disposed) return;
        showConversationSelection(); $('#sessionBrowserList').scrollTop = savedView.scrollTop || 0;
      }
    } catch (error) { if (!disposed) toast('恢复标签页失败：' + error.message, true); }
    finally { restoring = false; if (!disposed) { visibility(active); publish(); } }
  }
  function destination(target) {
    const current = snapshot();
    const sessionButton = target.closest('[data-conversation-session]');
    if (sessionButton && conversationView) {
      const key = sessionButton.dataset.conversationSession;
      const session = conversationView.sessions.find(item => conversationSessionKey(item) === key);
      return {...current, title:session?.name || '对话', conversation:{...current.conversation, selected:key, pane:'detail'}};
    }
    const sessionAction = target.closest('[data-session-action="details"]');
    if (sessionAction) return {...current, route:'/sessions', title:'对话', conversation:{scope:sessionAction.dataset.requirement ? {kind:'task', id:sessionAction.dataset.requirement, environment:activeEnvironment} : {kind:'all'}, selected:conversationEnvironmentKey(activeEnvironment,sessionAction.dataset.session), pane:'detail'}};
    const taskButton = target.closest('[data-action="open-requirement"], [data-action="jump-requirement"]');
    if (taskButton) return {route:'/requirements/' + taskButton.dataset.id, environment:taskButton.dataset.environment || activeEnvironment, title:taskButton.textContent.trim()};
    const projectButton = target.closest('[data-action="select-project"]');
    if (projectButton) return {route:'/projects', environment:activeEnvironment, title:state.projects.find(p => p.id === projectButton.dataset.id)?.name || '项目', project:{id:projectButton.dataset.id, detail:true, filter:'all'}};
    const taskShortcut = target.closest('[data-task-shortcut]');
    if (taskShortcut) {
      const task = shortcutTasks().find(item => shortcutTaskKey(item) === taskShortcut.dataset.taskShortcut);
      if (task) return {route:'/sessions', environment:activeEnvironment, title:task.name, conversation:{scope:{kind:'task',id:task.id,environment:task.environment_id || activeEnvironment},pane:'detail'}};
    }
    const directoryShortcut = target.closest('[data-directory-shortcut]');
    if (directoryShortcut) {
      const directory = shortcutDirectories().find(item => item.key === directoryShortcut.dataset.directoryShortcut);
      if (directory) return {route:'/sessions', environment:activeEnvironment, title:directory.name, conversation:{scope:{kind:'directory',cwd:directory.cwd,environment:directory.environment},pane:'detail'}};
    }
    const conversations = target.closest('[data-action="task-conversations"], [data-action="project-conversations"]');
    if (conversations) return {route:'/sessions',environment:activeEnvironment, title:'对话',conversation:{scope:{kind:conversations.dataset.action === 'task-conversations' ? 'task' : 'project', id:conversations.dataset.id, environment:activeEnvironment},pane:'detail'}};
    const nav = target.closest('[data-view]');
    if (nav) return {route:'/' + nav.dataset.view, environment:activeEnvironment};
    const link = target.closest('a[href^="#/"]');
    if (link) return {route:link.getAttribute('href').slice(1),environment:activeEnvironment};
    return null;
  }
  const open = saved => post('workhub:tab-open', {snapshot:saved});
  const command = event => { if (event.detail === 'new' && !disposed) open({environment:activeEnvironment}); };
  window.addEventListener('workhub:tab-command', command);
  const menu = document.createElement('div'); menu.className = 'workspace-tab-menu'; menu.hidden = true; menu.setAttribute('role','menu');
  const item = document.createElement('button'); item.type = 'button'; item.textContent = '在新标签页打开'; item.setAttribute('role','menuitem'); menu.append(item); document.body.append(menu);
  let menuDestination;
  item.addEventListener('click', () => { if (menuDestination) open(menuDestination); menu.hidden = true; });
  document.addEventListener('contextmenu', event => {
    const saved = destination(event.target);
    if (!saved) return;
    event.preventDefault(); menuDestination = saved; menu.hidden = false;
    menu.style.left = Math.min(event.clientX, Math.max(8, window.innerWidth - 180)) + 'px';
    menu.style.top = Math.min(event.clientY, Math.max(8, window.innerHeight - 45)) + 'px'; item.focus();
  });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) menu.hidden = true;
    if (event.target.closest('.brand[href="/"]') && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault(); event.stopImmediatePropagation(); navigate('/requirements'); return;
    }
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    const saved = destination(event.target);
    if (saved) {event.preventDefault(); event.stopImmediatePropagation(); open(saved);}
  }, true);
  document.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    const saved = destination(event.target);
    if (saved) {event.preventDefault(); event.stopImmediatePropagation(); open(saved);}
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {menu.hidden = true; event.preventDefault(); return;}
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if ((!event.shiftKey && ['t','w'].includes(event.key.toLowerCase())) || ['Tab','PageUp','PageDown'].includes(event.key) || /^[1-9]$/.test(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      post('workhub:tab-key', {key:{key:event.key,metaKey:event.metaKey,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey}});
    }
  }, true);
  document.addEventListener('click', schedule);
  document.addEventListener('input', schedule);
  document.addEventListener('change', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('workhub:workspace-refreshed', schedule);
  window.addEventListener('message', event => {
    if (event.source !== host || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'workhub:tab-restore') { layout(message.tabBarHeight); visibility(!!message.active); void restore(message.snapshot); }
    else if (message?.type === 'workhub:tab-layout') layout(message.height);
    else if (message?.type === 'workhub:tab-active') visibility(!!message.active);
    else if (message?.type === 'workhub:tab-navigate' && typeof message.route === 'string') navigate(message.route);
    else if (message?.type === 'workhub:tab-closing') dispose();
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector('title'), {childList:true});
  const chromeObserver = new MutationObserver(publishChrome);
  chromeObserver.observe(document.body, {attributes:true, attributeFilter:['class','style']});
  const chromeResize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishChrome);
  if (document.querySelector('.sidebar')) chromeResize?.observe(document.querySelector('.sidebar'));
  window.addEventListener('resize', publishChrome);
  function canClose() {
    if (state.busy || blockingMutationDialog()) {toast('请等待当前操作完成后关闭标签页'); return false;}
    return true;
  }
  function dispose() {
    if (disposed) return;
    // Existing pagehide handlers persist drafts and dispose UI subscriptions.
    window.dispatchEvent(new Event('pagehide'));
    disposed = true; clearTimeout(timer); observer.disconnect(); chromeObserver.disconnect(); chromeResize?.disconnect();
    window.removeEventListener('resize', publishChrome);
    window.removeEventListener('workhub:tab-command', command);
  }
  window.WorkHubTab = {snapshot,canClose,dispose,get active() {return active;}};
  visibility(false);
  window.addEventListener('workhub:workspace-ready', () => post('workhub:tab-ready'), {once:true});
})();
