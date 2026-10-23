import {build} from "esbuild";
import {mkdir, readFile, writeFile, readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "web/chat"), {recursive: true});
const result = await build({absWorkingDir: root, entryPoints: ["frontend/chat/main.tsx"], outfile: "web/chat/assistant.js", bundle: true, minify: true, format: "esm", target: ["es2022"], jsx: "automatic", define: {"process.env.NODE_ENV": '"production"'}, legalComments: "linked", metafile: true});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (!match || packages.has(match[1])) continue;
  const directory = path.join(root, match[1]);
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const texts = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)) texts.push(await readFile(path.join(directory, entry.name), "utf8"));
  }
  if (!texts.length) texts.push(await readFile(path.join(root, "scripts/licenses", pkg.name.replaceAll("/", "_") + ".txt"), "utf8"));
  packages.set(match[1], `\n${"=".repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license}\n${texts.join("\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`);
}
await writeFile(path.join(root,"web/chat/THIRD-PARTY-NOTICES.txt"), ("Work Hub task chat — browser dependency licenses\n" + [...packages].sort(([a],[b])=>a.localeCompare(b)).map(([,text])=>text).join("")).trimEnd() + "\n");
const legalPath = path.join(root, "web/chat/assistant.js.LEGAL.txt");
await writeFile(legalPath, (await readFile(legalPath, "utf8")).replace(/\r\n/g, "\n").replace(/^[ \t]+/gm, "").trimEnd() + "\n");
console.log(`Built assistant-ui task chat (${packages.size} dependency license notices)`);
