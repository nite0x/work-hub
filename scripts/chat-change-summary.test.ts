import {test} from "node:test";
import assert from "node:assert/strict";
import {parseFileChanges, summarizeFileChanges} from "../frontend/chat/change-summary";
import {convertEntry} from "../frontend/chat/model";

test("change summaries count content prefixes correctly and ignore patch metadata", () => {
  const files = parseFileChanges('src/配置 file.ts\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,2 +8,3 @@\n context\n-old\n+++content\n+new\n\\ No newline at end of file\nREADME.md\n@@ -1 +0,0 @@\n-removed\n');
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(({path, additions, deletions, line}) => ({path, additions, deletions, line})), [
    {path:'src/配置 file.ts', additions:2, deletions:1, line:9},
    {path:'README.md', additions:0, deletions:1, line:1},
  ]);
});

test("metadata keeps unusual names and accurate counts when preview text is truncated", () => {
  const files = parseFileChanges('no-extension\n@@ -1 +1 @@\n-old\n+new\n', [
    {path:'no-extension',additions:12,deletions:3},
    {path:'+new file',additions:400,deletions:0},
  ]);
  assert.equal(files.length,2);
  assert.equal(files[0].additions,12);
  assert.equal(files[1].path,'+new file');
  assert.deepEqual(files[1].patches,[]);
});

test("successful edits aggregate by resolved file, while pending and failed edits stay out", () => {
  const part = (path:string,status:string,cwd?:string) => ({type:'tool-call', args:{changes:`${path}\n@@ -1 +1 @@\n-a\n+b\n`,...(cwd?{cwd}: {})}, result:{status}});
  const files = summarizeFileChanges([part('app.ts','completed','/repo'),part('/repo/app.ts','completed'),part('app.ts','failed'),part('pending.ts','inProgress'),part('other.ts','declined'),part('app.ts','completed','/other')]);
  assert.equal(files.length,2);
  assert.equal(files[0].path,'/repo/app.ts');
  assert.equal(files[0].additions,2);
  assert.equal(files[0].deletions,2);
  assert.equal(files[0].patches.length,2);
  assert.equal(files[1].path,'/other/app.ts');
});

test("native metadata survives message conversion without forwarding arbitrary tool payloads", () => {
  const file_changes=[{path:'a',additions:7,deletions:2}];
  const message = convertEntry({id:'edit',turn_id:'t',kind:'change',status:'completed',text:'a\n+ok',file_changes});
  const part=message.content[0];
  assert.equal(part.type,'tool-call');
  if(part.type!=='tool-call') return;
  assert.deepEqual(part.args.files,file_changes);
  assert.equal(summarizeFileChanges([part])[0].additions,7);
});
