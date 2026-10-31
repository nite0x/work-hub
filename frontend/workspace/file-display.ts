import { File, FileDiff, parsePatchFiles } from "@pierre/diffs"

export interface FilePreview { text: string; format?: "patch" | "file" | "text"; name: string; truncated?: boolean; line?: number }
export interface FileDisplay { render(container: HTMLElement, preview: FilePreview, split: boolean): () => void }

// The app permits external styles and CSSOM updates, but blocks inline style
// tags/attributes. Pierre emits grid row spans and token colors as attributes;
// without applying them through CSSOM, all subgrid rows collapse into one.
// Keep the existing policy and install only the viewer's generated styles.
function createStyleInstaller() {
  const styles = new WeakMap<HTMLStyleElement, {text: string; sheet: CSSStyleSheet}>()
  const managed = new WeakMap<ShadowRoot, CSSStyleSheet[]>()
  const attributes = new WeakMap<HTMLElement, string>()
  return (node: HTMLElement) => {
    const root = node.shadowRoot
    if (!root) return
    const sheets = [...root.querySelectorAll("style")].map(style => {
      const text = style.textContent || ""
      let record = styles.get(style)
      if (!record) { record = {text: "", sheet: new CSSStyleSheet()}; styles.set(style, record) }
      if (record.text !== text) { record.sheet.replaceSync(text); record.text = text }
      return record.sheet
    })
    const previous = managed.get(root) || []
    if (sheets.length !== previous.length || sheets.some((sheet, index) => sheet !== previous[index])) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets.filter(sheet => !previous.includes(sheet)), ...sheets]
      managed.set(root, sheets)
    }
    for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
      const text = element.getAttribute("style") || ""
      if (attributes.get(element) !== text) { element.style.cssText = text; attributes.set(element, text) }
    }
  }
}

const display: FileDisplay = {
  render(container, preview, split) {
    const installStyles = createStyleInstaller()
    const options = { theme: "pierre-light" as const, themeType: "light" as const, overflow: "scroll" as const, onPostRender: installStyles }
    const instances: (File | FileDiff)[] = []
    try {
      if (preview.format === "file") {
        const line = preview.line ? Math.min(preview.line, preview.text.split("\n").length) : undefined
        let located = false
        const instance = new File({ ...options, onPostRender(node) {
          installStyles(node)
          const target = line && !located ? node.shadowRoot?.querySelector(`[data-line="${line}"]`) : undefined
          if (target) {
            located = true
            const row = target.getBoundingClientRect()
            const viewport = container.getBoundingClientRect()
            container.scrollTop += row.top - viewport.top - (container.clientHeight - row.height) / 2
          }
        } })
        instances.push(instance)
        instance.render({ file: { name: preview.name, contents: preview.text }, containerWrapper: container })
        if (line) instance.setSelectedLines({start: line, end: line})
      } else {
        const patches = parsePatchFiles(preview.text)
        for (const patch of patches) for (const fileDiff of patch.files) {
          const instance = new FileDiff({ ...options, diffStyle: split ? "split" : "unified" })
          instances.push(instance)
          instance.render({ fileDiff, containerWrapper: container })
        }
        // Binary files, mode-only changes and empty patches remain readable.
        if (!instances.length) container.textContent = preview.text || "此区域没有文本差异。"
      }
    } catch {
      instances.forEach(instance => instance.cleanUp())
      container.textContent = preview.text
    }
    return () => { instances.forEach(instance => instance.cleanUp()); container.replaceChildren() }
  },
}
;(window as Window & { WorkHubFileDisplay?: FileDisplay }).WorkHubFileDisplay = display
