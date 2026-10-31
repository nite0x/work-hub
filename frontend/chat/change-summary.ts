import {sourceFileReference} from "./links";
import {directoryKey} from "../workspace/conversation-context";

export interface FileChangePaths {cwd?: string; projectRoots: readonly string[]; additionalDirectories?: readonly string[]}

export function changePathLabel(path: string, paths: FileChangePaths) {
  const absolute = /^(?:[\\/]|[a-z]:[\\/])/i.test(path);
  const fullPath = !absolute && paths.cwd ? `${paths.cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}` : path;
  const normalized = fullPath.replace(/\\/g, "/");
  const key = directoryKey(normalized);
  const matchRoot = (roots: readonly string[]) => roots.filter(Boolean).map(root => ({
    prefix: root.replace(/\\/g, "/").replace(/\/+$/, "") + "/", key: directoryKey(root),
  })).filter(root => key.startsWith(root.key === "/" ? "/" : root.key + "/"))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.prefix;
  // Prefer the actual project root even when the chat runs in a subdirectory.
  const root = matchRoot(paths.projectRoots) || matchRoot([paths.cwd || "", ...(paths.additionalDirectories || [])]);
  return {label: root ? normalized.slice(root.length) : path.replace(/^\.\//, ""), fullPath};
}

export interface FileChangeCount {path: string; additions: number; deletions: number}
export interface FileChange extends FileChangeCount {line: number; patches: string[]}

// The API's change text consists of a path followed by its patch. Metadata is
// authoritative when present; the parser also supports older saved records.
export function parseFileChanges(text: string, files?: FileChangeCount[]): FileChange[] {
  const lines = text.split("\n");
  const known = files ? new Set(files.map(file => file.path)) : undefined;
  const headers: {index: number; path: string}[] = [];
  for (let index = 0; index < lines.length; index++) {
    const label = lines[index];
    if (known ? known.has(label) : !/^[+\-@ \\]|^(?:diff --git |index |Binary files |new file mode |deleted file mode |old mode |new mode |similarity index |rename (?:from|to) )/.test(label) && !!sourceFileReference(label)) {
      headers.push({index, path: label});
    }
  }
  const patches = new Map<string, FileChange>();
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const patch = lines.slice(header.index + 1, headers[index + 1]?.index).join("\n").trimEnd();
    let additions = 0, deletions = 0, current = 0, first = 0, inHunk = false;
    for (const line of patch.split("\n")) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {current = Math.max(1, Number(hunk[1])); inHunk = true; continue;}
      if (!inHunk && /^(?:\+\+\+ |--- )/.test(line)) continue;
      if (line.startsWith("+")) { additions++; first ||= current || 1; current++; }
      else if (line.startsWith("-")) { deletions++; first ||= current || 1; }
      else if (line.startsWith(" ") && current) current++;
    }
    patches.set(header.path, {path: header.path, additions, deletions, line: first || 1, patches: patch ? [patch] : []});
  }
  return files ? files.map(file => ({...patches.get(file.path), ...file, line: patches.get(file.path)?.line || 1, patches: patches.get(file.path)?.patches || []})) : [...patches.values()];
}

interface ChangePart {type: string; args?: Record<string, unknown>; result?: unknown; isError?: boolean}
export function summarizeFileChanges(parts: readonly ChangePart[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const part of parts) {
    if (part.type !== "tool-call" || typeof part.args?.changes !== "string" || part.isError || (part.result as {status?: string} | undefined)?.status !== "completed") continue;
    const metadata = Array.isArray(part.args.files) ? part.args.files as FileChangeCount[] : undefined;
    for (const file of parseFileChanges(part.args.changes, metadata)) {
      const cwd = typeof part.args.cwd === "string" ? part.args.cwd.replace(/\\/g, "/").replace(/\/$/, "") : "";
      const path = cwd && !/^(?:\/|[a-z]:[\\/])/i.test(file.path) ? `${cwd}/${file.path.replace(/^\.\//, "")}` : file.path;
      const key = path.replace(/\\/g, "/").replace(/(^|\/)\.\//g, "$1");
      const previous = files.get(key);
      files.set(key, previous ? {...previous, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions, patches: [...previous.patches, ...file.patches]} : {...file, path});
    }
  }
  return [...files.values()];
}
