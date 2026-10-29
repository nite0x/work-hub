// Keep the distinguishing tail readable while the copy action retains the exact path.
export function compactWorkspacePath(path: string) {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean)
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : path
}
