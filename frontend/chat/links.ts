export interface FileReference {path: string; line: number}

export function fileReference(href: string): FileReference | null {
  let path = href.trim();
  if (!path || path.startsWith("#") || path.startsWith("//") || /^(?:https?|mailto):/i.test(path)) return null;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.host && url.host !== "localhost") path = `//${url.host}${url.pathname}${url.hash}`;
      else path = url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch { return null; }
  } else if (!/^[a-z]:[\\/]/i.test(path) && !/^[^:/\\]+\.[a-z0-9]+:\d+(?:-\d+)?(?::\d+)?$/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  const suffix = path.match(/(?:#L?(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?:-\d+)?(?::\d+)?)$/i);
  const line = suffix ? Number(suffix[1] || suffix[2]) : 1;
  if (suffix) path = path.slice(0, suffix.index);
  if (!path || !Number.isSafeInteger(line) || line < 1 || line > 10000000 || path.includes("?") || path.includes("#")) return null;
  return {path, line};
}

// Preserve file references that Markdown's default URL filter drops (drive
// letters and file:), while keeping executable URL schemes out of the DOM.
export function chatURLTransform(url: string, key: string): string {
  if (key === "href" && fileReference(url)) return url;
  const colon = url.indexOf(":");
  if (colon < 0 || ["/", "?", "#"].some(c => url.indexOf(c) >= 0 && url.indexOf(c) < colon) || /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon))) return url;
  return "";
}

// Inline code also contains commands and identifiers; recognize only paths or
// familiar file names, rather than turning every code span into a file action.
export function sourceFileReference(value: string): FileReference | null {
  if (value !== value.trim() || /[\r\n<>{};|]/.test(value)) return null;
  const ref = fileReference(value);
  if (!ref || /^(?:https?:|mailto:)/i.test(value)) return null;
  const path = ref.path;
  const pathLike = /^(?:\.{0,2}[\/\\]|[a-z]:[\/\\]|[^\s:]+[\/\\])/i.test(path);
  const fileName = /^(?:[\w@+.-]+\.(?:tsx?|jsx?|mjs|cjs|go|py|rs|java|kt|swift|vue|svelte|css|scss|html?|json|ya?ml|toml|md|txt|sql|sh|bash|xml|lock|mod|sum)|\.[\w.-]+|Dockerfile|Makefile|LICENSE|NOTICE|Jenkinsfile|Procfile)$/i.test(path);
  const leaf = path.split(/[\\/]/).at(-1) || "";
  const hasFileName = /(?:\.[\w-]{1,16}$)|^(?:Dockerfile|Makefile|LICENSE|NOTICE|Jenkinsfile|Procfile)$/i.test(leaf);
  return (pathLike && hasFileName) || fileName ? ref : null;
}
