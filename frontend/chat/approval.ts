export interface ApprovalChoice { id: string; label: string; description?: string; accepts: boolean }
export interface ElicitationField {
  name: string; title: string; description?: string; type: string; required: boolean;
  options?: {value: string; label: string}[]; default?: unknown; format?: string;
  minimum?: number; maximum?: number; min_length?: number; max_length?: number;
}
export interface Elicitation {
  mode: string; server_name: string; url?: string; fields?: ElicitationField[];
  json_fallback?: boolean; schema?: unknown; error?: string;
}

export function safeElicitationURL(value?: string) {
  try {
    const url = new URL(value || "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

// Use the form's realm so this works in both the React panel and the static
// workspace renderer. Values retain their schema types and original enum IDs.
export function readElicitation(form: HTMLFormElement, elicitation?: Elicitation): Record<string, unknown> | undefined {
  if (!elicitation || elicitation.mode === "url") return undefined;
  const data = new form.ownerDocument.defaultView!.FormData(form);
  if (elicitation.json_fallback) {
    let value: unknown;
    try { value = JSON.parse(String(data.get("elicitation-json") || "{}")); }
    catch { throw new Error("请输入有效的 JSON 回答"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("表单回答必须是 JSON 对象");
    return value as Record<string, unknown>;
  }
  const entries: [string, unknown][] = [];
  for (const field of elicitation.fields || []) {
    const name = `elicitation:${field.name}`;
    if (field.type === "array") {
      const values = data.getAll(name).map(String);
      if (values.length || field.required) entries.push([field.name, values]);
      continue;
    }
    const value = data.get(name);
    if (value === null || value === "") continue;
    if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new Error(`${field.title}需要填写${field.type === "integer" ? "整数" : "数字"}`);
      entries.push([field.name, number]);
    } else if (field.type === "boolean") entries.push([field.name, value === "true"]);
    else entries.push([field.name, field.options?.length ? JSON.parse(String(value)) : String(value)]);
  }
  return Object.fromEntries(entries);
}
