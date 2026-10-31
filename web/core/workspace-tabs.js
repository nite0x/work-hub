'use strict';

(() => {
  const storageKey = 'workhub:workspace-tabs:v1';
  const tabs = [];
  let selected = '';
  let initialized = false, saveTimer, lastSaved = '';
  let writes = Promise.resolve();
  const headers = {'Content-Type':'application/json', 'X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content, 'X-Environment-ID':'local'};
  const payload = () => ({selected, tabs:tabs.map(tab => ({id:tab.id, snapshot:tab.snapshot}))});
  function flush() {
    clearTimeout(saveTimer);
    if (!initialized || !selected || typeof fetch !== 'function') return;
    const body = JSON.stringify(payload());
    if (body === lastSaved) return;
    lastSaved = body;
    writes = writes.catch(() => {}).then(async () => {
      const response = await fetch('/api/workspace-tabs', {method:'PUT', headers, body, keepalive:true});
      if (!response.ok) throw new Error('标签页保存失败');
    }).catch(() => {lastSaved = '';});
  }
  const bar = document.getElementById('workspaceTabBar');
  const pages = document.getElementById('workspacePages');
  let barSignature = '';
  let tabBarHeight = 0;
  function renderBar() {
    const height = tabs.length > 1 ? 40 : 0;
    bar.hidden = height === 0;
    if (height !== tabBarHeight) {
      tabBarHeight = height;
      for (const tab of tabs) send(tab, 'workhub:tab-layout', {height});
    }
    const items = tabs.map(tab => ({id:tab.id, title:tab.snapshot.title, kind:tab.snapshot.kind, context:tab.snapshot.context, environment:tab.snapshot.environment}));
    const signature = JSON.stringify([items, selected, initialized]);
    if (signature === barSignature) return;
    barSignature = signature;
    window.WorkHubTabbar.render(bar, {
      tabs:items, selected, ready:initialized,
      select:activate, close:remove,
      create:() => add({environment:tabs.find(tab => tab.id === selected)?.snapshot.environment}),
      duplicate,
    });
  }
  function normalize(value) {
    const snapshot = value && typeof value === 'object' ? value : {};
    const route = typeof snapshot.route === 'string' && /^\/(requirements(?:\/[\w-]+)?|projects|sessions|settings)$/.test(snapshot.route) ? snapshot.route : '/requirements';
    return {...snapshot, route, environment: typeof snapshot.environment === 'string' ? snapshot.environment : 'local', title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 200) : '任务', kind: route.split('/')[1]};
  }
  function save() {
    if (!selected) return;
    try { localStorage.setItem(storageKey, JSON.stringify(payload())); } catch { /* The database remains available without browser storage. */ }
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250);
  }
  function send(tab, type, detail = {}) {
    if (tab?.ready) tab.frame.contentWindow.postMessage({type, ...detail}, location.origin);
  }
  function syncURL(tab) {
    const url = new URL(location.href);
    if (tab.snapshot.environment === 'local') url.searchParams.delete('environment'); else url.searchParams.set('environment', tab.snapshot.environment);
    url.hash = tab.snapshot.route;
    history.replaceState(null, '', url);
    document.title = tab.snapshot.title + ' · Work Hub';
  }
  function label(tab) {
    tab.frame.title = tab.snapshot.title;
    renderBar();
  }
  function alignBar(tab) {
    if (!tab.chrome) return;
    document.body.style.setProperty('--workspace-sidebar-width', tab.chrome.left + 'px');
    document.body.style.setProperty('--workspace-tabs-top', tab.chrome.top + 'px');
  }
  function activate(id, focus = false) {
    const current = tabs.find(tab => tab.id === selected);
    if (current && current.id !== id) send(current, 'workhub:tab-active', {active: false});
    const tab = tabs.find(tab => tab.id === id);
    if (!tab) return;
    selected = id;
    alignBar(tab);
    for (const item of tabs) {
      const active = item === tab;
      item.frame.hidden = !active;
    }
    send(tab, 'workhub:tab-active', {active: true});
    syncURL(tab); save(); renderBar();
    if (focus) document.getElementById('tab-' + id)?.focus();
  }
  function add(snapshot, id = crypto.randomUUID(), select = true) {
    snapshot = normalize(snapshot);
    const frame = document.createElement('iframe'); frame.className = 'workspace-page'; frame.id = 'page-' + id; frame.setAttribute('role', 'tabpanel'); frame.setAttribute('aria-labelledby', 'tab-' + id); frame.hidden = true;
    const url = new URL('/', location.href); url.searchParams.set('workspace-tab', id);
    if (snapshot.environment !== 'local') url.searchParams.set('environment', snapshot.environment);
    url.hash = snapshot.route; frame.src = url.href;
    // Reserve the bar before slow API initialization finishes publishing tab-ready.
    frame.addEventListener('load', () => frame.contentWindow.postMessage({type:'workhub:tab-layout', height:tabBarHeight}, location.origin));
    const tab = {id, snapshot, frame, ready:false};
    tabs.push(tab); label(tab); pages.append(frame);
    if (select) activate(id); else save();
    return tab;
  }
  function remove(id) {
    const index = tabs.findIndex(tab => tab.id === id);
    if (index < 0) return;
    const tab = tabs[index];
    // Do not unload forms while a foreground mutation is being submitted.
    try { if (tab.ready && !tab.frame.contentWindow.WorkHubTab.canClose()) return; } catch { return; }
    // pagehide flushes existing draft persistence; it never stops a backend run.
    send(tab, 'workhub:tab-closing');
    try { tab.frame.contentWindow.WorkHubTab?.dispose(); } catch { /* A loading page has no bridge yet. */ }
    tab.frame.remove(); tabs.splice(index, 1);
    if (!tabs.length) { selected = ''; add({environment:tab.snapshot.environment}); }
    else if (selected === id) activate(tabs[Math.min(index, tabs.length - 1)].id, true);
    save(); renderBar();
  }
  function keydown(event) {
    if (!initialized || !tabs.length) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 't' && !event.shiftKey) { event.preventDefault(); add({environment: tabs.find(tab => tab.id === selected)?.snapshot.environment}); }
    else if (key === 'w' && !event.shiftKey) { event.preventDefault(); remove(selected); }
    else if (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const direction = event.shiftKey || event.key === 'PageUp' ? -1 : 1;
      activate(tabs[(tabs.findIndex(tab => tab.id === selected) + tabs.length + direction) % tabs.length].id, true);
    } else if (/^[1-9]$/.test(key)) { event.preventDefault(); const tab = tabs[key === '9' ? tabs.length - 1 : Number(key) - 1]; if (tab) activate(tab.id); }
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const tab = tabs.find(tab => tab.frame.contentWindow === event.source);
    if (!tab) return;
    if (event.data.type === 'workhub:tab-ready') {
      tab.ready = true;
      send(tab, 'workhub:tab-restore', {snapshot:tab.snapshot, active:tab.id === selected, tabBarHeight});
    } else if (event.data.type === 'workhub:tab-state') {
      tab.snapshot = normalize(event.data.snapshot); label(tab); save();
      if (tab.id === selected) syncURL(tab);
    } else if (event.data.type === 'workhub:tab-open') add(event.data.snapshot);
    else if (event.data.type === 'workhub:tab-chrome') {
      const chrome = event.data.chrome;
      if (!chrome || !Number.isFinite(chrome.left) || !Number.isFinite(chrome.top)) return;
      tab.chrome = {left:Math.max(0, Math.min(innerWidth, chrome.left)), top:Math.max(0, Math.min(innerHeight, chrome.top))};
      if (tab.id === selected) alignBar(tab);
    }
    else if (event.data.type === 'workhub:tab-key') keydown({...event.data.key, preventDefault() {}});
  });
  function duplicate() {
    const tab = tabs.find(tab => tab.id === selected);
    if (!tab) return;
    let current = tab.snapshot;
    try { current = tab.frame.contentWindow.WorkHubTab?.snapshot() || current; } catch { /* Use the last published navigation. */ }
    add(current);
  }
  document.addEventListener('keydown', keydown);
  window.addEventListener('workhub:tab-command', event => {
    if (event.detail === 'new') add({environment:tabs.find(tab => tab.id === selected)?.snapshot.environment});
    else if (event.detail === 'close') remove(selected);
  });
  window.addEventListener('hashchange', () => send(tabs.find(tab => tab.id === selected), 'workhub:tab-navigate', {route:location.hash.slice(1)}));
  window.addEventListener('pagehide', () => { for (const tab of tabs) { try { tab.snapshot = normalize(tab.frame.contentWindow.WorkHubTab?.snapshot() || tab.snapshot); } catch {} } save(); flush(); });
  async function start() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* Start fresh if storage is unavailable. */ }
  if (typeof fetch === 'function') {
    try {
      const response = await fetch('/api/workspace-tabs', {headers});
      if (!response.ok) throw new Error('标签页读取失败');
      const stored = await response.json();
      if (stored.initialized) saved = stored;
    } catch { /* Keep the current origin's recovery copy when offline. */ }
  }
  initialized = true;
  const restored = Array.isArray(saved?.tabs) ? saved.tabs.filter(tab => tab && typeof tab.id === 'string' && /^[\w-]{1,100}$/.test(tab.id) && tab.snapshot && typeof tab.snapshot === 'object') : [];
  for (const tab of restored) if (!tabs.some(existing => existing.id === tab.id)) add(tab.snapshot, tab.id, false);
  if (!tabs.length) add({route:location.hash.slice(1), environment:new URLSearchParams(location.search).get('environment') || 'local'});
  else {
    const requested = location.hash.slice(1);
    const target = tabs.find(tab => tab.id === saved.selected) || tabs[0];
    // An explicit deep link takes precedence over the saved active page.
    if (requested && requested !== target.snapshot.route) {
      const clean = normalize({route:requested, environment:new URLSearchParams(location.search).get('environment') || 'local'});
      add(clean);
    } else activate(target.id);
  }
  }
  renderBar(); void start();
})();
