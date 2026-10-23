import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {NativeSelect, NativeSelectOption as Option} from "@/components/ui/native-select";
import {safeElicitationURL, type Elicitation, type ApprovalChoice} from "./approval";
import {cleanText} from "./model";

export function ElicitationFields({elicitation: e, disabled = false}: {elicitation?: Elicitation; disabled?: boolean}) {
  if (!e) return null;
  const url = safeElicitationURL(e.url);
  return <div className="space-y-3" data-elicitation-mode={e.mode}>
    {e.server_name && <p className="m-0 text-xs text-muted-foreground">工具服务 · {cleanText(e.server_name)}</p>}
    {e.error ? <p role="alert" className="m-0 text-sm text-destructive">{cleanText(e.error)}</p> : null}
    {e.mode === "url" && url && <div className="space-y-2 text-sm"><a data-elicitation-open="" className="block break-all text-primary underline" href={url} target="_blank" rel="noopener noreferrer" aria-disabled={disabled}>在浏览器中打开 ↗<br />{cleanText(e.url)}</a><p className="m-0 text-xs text-muted-foreground">在浏览器中完成登录或操作后，点击“已完成，继续”。打开链接不会自动提交确认。</p></div>}
    {e.json_fallback ? <fieldset className="m-0 min-w-0 space-y-2 border-0 p-0 text-sm" disabled={disabled}><legend className="mb-2">JSON 回答</legend><Textarea name="elicitation-json" aria-label="JSON 回答" autoComplete="off" spellCheck={false} defaultValue="{}" className="min-h-28 font-mono text-xs" /><details className="text-xs"><summary>查看工具要求的表单结构</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(e.schema, null, 2)}</pre></details></fieldset> : null}
    {(e.fields || []).map(f => {
      const name = `elicitation:${f.name}`;
      const title = `${cleanText(f.title)}${f.required ? "（必填）" : "（选填）"}`;
      const defaultValue = f.default == null ? "" : String(f.default);
      return <fieldset key={f.name} className="m-0 min-w-0 space-y-2 border-0 p-0 text-sm" disabled={disabled}><legend className="mb-2">{title}</legend>
        {f.description && <p className="m-0 text-xs text-muted-foreground">{cleanText(f.description)}</p>}
        {f.type === "array" ? <div className="space-y-2">{(f.options || []).map(o => <label key={o.value} className="flex items-center gap-2"><input type="checkbox" name={name} value={o.value} defaultChecked={Array.isArray(f.default) && f.default.includes(o.value)} className="size-4 shrink-0" />{cleanText(o.label)}</label>)}</div>
          : f.type === "boolean" ? <NativeSelect name={name} aria-label={title} required={f.required} defaultValue={defaultValue}><Option value="">请选择</Option><Option value="true">是</Option><Option value="false">否</Option></NativeSelect>
          : f.options?.length ? <NativeSelect name={name} aria-label={title} required={f.required} defaultValue={f.default == null ? "" : JSON.stringify(f.default)}><Option value="">请选择</Option>{f.options.map(o => <Option key={o.value} value={JSON.stringify(o.value)}>{cleanText(o.label)}</Option>)}</NativeSelect>
          : <Input name={name} aria-label={title} type={f.type === "number" || f.type === "integer" ? "number" : f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : "text"} step={f.type === "integer" ? 1 : "any"} min={f.minimum} max={f.maximum} minLength={f.min_length} maxLength={f.max_length} required={f.required} defaultValue={defaultValue} placeholder={f.format === "date-time" ? "2026-10-23T10:00:00+08:00" : undefined} autoComplete="off" />}
      </fieldset>;
    })}
  </div>;
}

export function ApprovalActions({approval, disabled = false, sending = false}: {approval: {choices?: ApprovalChoice[]; can_accept?: boolean; kind?: string}; disabled?: boolean; sending?: boolean}) {
  const choices = approval.choices || [{id: "decline", label: "拒绝", accepts: false}, ...(approval.can_accept ? [{id: "accept", label: approval.kind === "questions" ? "提交回答" : "允许一次", accepts: true}] : [])];
  return <div className="w-full space-y-2">{choices.filter(c => c.description).map(choice => <div key={choice.id} className="space-y-1 text-xs"><strong>{cleanText(choice.label)}</strong><pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-all">{cleanText(choice.description)}</pre></div>)}<div className="flex flex-wrap justify-end gap-2">{choices.map(choice => <Button key={choice.id} type={choice.accepts ? "submit" : "button"} name="decision" value={choice.id} data-chat-decision={choice.accepts ? undefined : choice.id} size="sm" variant={choice.accepts ? "default" : "outline"} disabled={disabled}>{sending ? "正在提交…" : cleanText(choice.label)}</Button>)}</div></div>;
}
