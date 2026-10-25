import {before, test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";

let bundle = "";
before(async () => {
  const result = await build({entryPoints: ["web/chat/loader.js"], bundle: true, write: false, format: "iife", plugins: [{
    name: "chat-bridge-fixture",
    setup(builder) {
      builder.onResolve({filter: /^\/chat\/assistant\.js$/}, () => ({path: "bridge", namespace: "fixture"}));
      builder.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents: "export const bridge = window.testBridge;"}));
    },
  }]});
  bundle = result.outputFiles[0].text;
});

function mount() {
  const dom = new JSDOM('<div id="assistantChatRoot"></div>', {runScripts: "outside-only"});
  const calls: {method: string; value?: any}[] = [];
  const window = dom.window as any;
  window.testBridge = Object.fromEntries(["open", "close", "updateWorkspace", "updateSession"].map(method => [method, (value: unknown) => calls.push({method, value})]));
  window.eval(bundle);
  return {dom, calls, loader: window.WorkHubAssistant};
}

test("lazy chat loading retains workspace refreshes received before the bridge mounts and forwards later metadata", async () => {
  const h = mount();
  try {
    const workspace = {tasks: [{id: "task"}], projects: [{id: "project"}]};
    const pending = h.loader.open({workspace: {tasks: [], projects: []}});
    h.loader.updateWorkspace(workspace);
    await pending;
    assert.equal(h.calls.find(c => c.method === "open")?.value.workspace, workspace);
    const refreshed = {...workspace, projects: [{id: "project", branch: "feature/ui"}]};
    h.loader.updateWorkspace(refreshed);
    const session = {id: "session", name: "新的会话标题"};
    h.loader.updateSession(session);
    assert.equal(h.calls.find(c => c.method === "updateWorkspace")?.value, refreshed);
    assert.equal(h.calls.find(c => c.method === "updateSession")?.value, session);
  } finally {h.dom.window.close();}
});

test("switching conversations during lazy loading mounts only the newest workspace", async () => {
  const h = mount();
  try {
    const first = h.loader.open({session: {id: "old"}, workspace: {projects: [{id: "old"}]}});
    const workspace = {tasks: [], projects: [{id: "new"}]};
    const second = h.loader.open({session: {id: "new"}, workspace});
    await Promise.all([first, second]);
    const opened = h.calls.filter(c => c.method === "open");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].value.session.id, "new");
    assert.equal(opened[0].value.workspace, workspace);
  } finally {h.dom.window.close();}
});
