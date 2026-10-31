import {test} from "node:test";
import assert from "node:assert/strict";
import {fileReference, chatURLTransform, sourceFileReference} from "../frontend/chat/links";

test("chat file links preserve native paths and line references", () => {
  for (const [href, path, line] of [
    ["/home/user/repo/config.go:42", "/home/user/repo/config.go", 42],
    ["src/config.ts#L12-L20", "src/config.ts", 12],
    ["src/config.ts#L12C3-L20C5", "src/config.ts", 12],
    ["./配置%20file.go:7:4", "./配置 file.go", 7],
    ["C:\\repo\\file.go:5", "C:\\repo\\file.go", 5],
    ["file:///C:/repo/file.go#L9", "C:/repo/file.go", 9],
    ["file:///home/user/repo/file.go:2", "/home/user/repo/file.go", 2],
    ["README.md", "README.md", 1],
  ] as const) {
    assert.deepEqual(fileReference(href), {path, line});
    assert.equal(chatURLTransform(href, "href"), href);
  }
  for (const href of ["https://example.com/a:2", "http://example.com", "//example.com/path", "mailto:a@example.com", "#heading", "javascript:alert(1)", "data:text/html,hello", "/bad%00path", "/file.go:0"]) assert.equal(fileReference(href), null, href);
  assert.equal(chatURLTransform("javascript:alert(1)", "href"), "");
  assert.equal(chatURLTransform("data:text/html,hello", "href"), "");
  assert.equal(chatURLTransform("https://example.com", "href"), "https://example.com");
});


test("inline file names distinguish source references from commands, identifiers and API routes", () => {
 for (const [value,path,line] of [["app.ts:42","app.ts",42],["src/app.ts:42-50","src/app.ts",42],["README.md","README.md",1],["C:\\repo\\app.go:7","C:\\repo\\app.go",7],["src/配置 file.go#L18","src/配置 file.go",18]] as const) {
  assert.deepEqual(sourceFileReference(value),{path,line});
 }
 for(const value of ["npm test","const count = 1","module.call()","/api/projects","src/","https://example.com/file.ts","src/file.ts; rm file","javascript:alert(1)"]) assert.equal(sourceFileReference(value),null,value);
});
