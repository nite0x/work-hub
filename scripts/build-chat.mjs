import {build} from "esbuild";
import {mkdir, readFile, writeFile, readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {build as buildCSS} from "vite";
import tailwindcss from "@tailwindcss/vite";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "web/chat"), {recursive: true});
const result = await build({absWorkingDir: root, entryPoints: ["frontend/chat/main.tsx"], outfile: "web/chat/assistant.js", bundle: true, minify: true, format: "esm", target: ["es2022"], jsx: "automatic", define: {"process.env.NODE_ENV": '"production"'}, legalComments: "linked", metafile: true,
  plugins: [{name: "css-built-by-vite", setup(builder) {
    builder.onLoad({filter: /\.css$/}, () => ({contents: "", loader: "css"}));
  }}],
});
// Official registry components ship Tailwind classes. Compile their stylesheet
// independently so chat:build doesn't depend on a preceding workspace UI build.
await buildCSS({
  root, configFile: false, plugins: [tailwindcss()],
  build: {outDir: "web/chat", emptyOutDir: false, rollupOptions: {
    input: "frontend/chat/style.css", output: {assetFileNames: "assistant.css"},
  }},
});
const packages = new Map();
for (const input of [...Object.keys(result.metafile.inputs), "node_modules/tw-shimmer/package.json", "node_modules/tw-animate-css/package.json"]) {
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
const registryLicenses = `\nOfficial assistant-ui registry sources\n${await readFile(path.join(root, "frontend/components/assistant-ui/LICENSE"), "utf8")}\nOfficial shadcn UI sources\n${await readFile(path.join(root, "frontend/shadcn-LICENSE.md"), "utf8")}`;
await writeFile(path.join(root,"web/chat/THIRD-PARTY-NOTICES.txt"), ("Work Hub task chat — browser dependency licenses\n" + registryLicenses + [...packages].sort(([a],[b])=>a.localeCompare(b)).map(([,text])=>text).join("")).trimEnd() + "\n");
const legalPath = path.join(root, "web/chat/assistant.js.LEGAL.txt");
await writeFile(legalPath, (await readFile(legalPath, "utf8")).replace(/\r\n/g, "\n").replace(/^[ \t]+/gm, "").trimEnd() + "\n");
console.log(`Built assistant-ui task chat (${packages.size} dependency license notices)`);
