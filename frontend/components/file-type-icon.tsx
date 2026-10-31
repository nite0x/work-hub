import { Atom, FileArchive, FileCode, FileCog, FileImage, FileJson, FileText, Palette, Terminal } from "lucide-react"

const types = {
  tsx: "react", jsx: "react", ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", go: "go", py: "python",
  java: "java", kt: "java", json: "json", jsonc: "json", css: "style", scss: "style",
  less: "style", html: "markup", vue: "vue", svelte: "markup", md: "document", mdx: "document",
  txt: "document", png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image",
  webp: "image", sh: "shell", bash: "shell", zsh: "shell", ps1: "shell",
  yml: "config", yaml: "config", toml: "config", ini: "config", env: "config",
  zip: "archive", gz: "archive", tar: "archive",
} as const

export function FileTypeIcon({ path }: { path: string }) {
  const name = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase()
  const extension = name.split(".").pop()! as keyof typeof types
  const kind = name.startsWith(".env") || name === "dockerfile" ? "config" : types[extension] || "code"
  const label = kind === "typescript" ? "TS" : kind === "javascript" ? "JS" : kind === "go" ? "Go" : kind === "python" ? "Py" : undefined
  const Icon = kind === "react" ? Atom : kind === "json" ? FileJson : kind === "config" ? FileCog : kind === "style" ? Palette : kind === "image" ? FileImage : kind === "shell" ? Terminal : kind === "document" ? FileText : kind === "archive" ? FileArchive : FileCode
  return <span className={`file-type-icon${label ? " file-type-label" : ""}`} data-file-kind={kind} aria-hidden="true">{label || <Icon />}</span>
}
