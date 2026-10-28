import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type PropsWithChildren} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {XIcon} from "lucide-react";
import type {ChatController} from "./controller";
import {fileReference, type FileReference} from "./links";

interface FilePreview {path: string; lines: string[]; start_line: number; total_lines: number; line: number; requested_line: number}
const LinkContext = createContext<{controller: ChatController; open: (ref: FileReference, trigger: HTMLElement) => void} | null>(null);

export function ChatFileProvider({controller, children}: PropsWithChildren<{controller: ChatController}>) {
  const host = useRef<HTMLDivElement>(null);
  const selectedLine = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<FileReference | null>(null);
  const [result, setResult] = useState<{target: FileReference; file?: FilePreview; error?: string} | null>(null);
  const open = useCallback((ref: FileReference, element: HTMLElement) => {trigger.current = element; setTarget(ref);}, []);
  const links = useMemo(() => ({controller, open}), [controller, open]);
  useEffect(() => {
    if (!target) return;
    const abort = new AbortController();
    const session = controller.getSnapshot().session?.id;
    if (!session) {setResult({target, error: "请先打开一个已保存的对话"}); return;}
    void controller.options.request<FilePreview>(`/api/sessions/${encodeURIComponent(session)}/file?path=${encodeURIComponent(target.path)}&line=${target.line}`, {signal: abort.signal}).then(
      file => {if (!abort.signal.aborted) setResult({target, file});},
      error => {if (!abort.signal.aborted) setResult({target, error: (error as Error).message});},
    );
    return () => abort.abort();
  }, [target, controller]);
  const loaded = result?.target === target ? result : null;
  const file = loaded?.file;
  useEffect(() => {if (file) selectedLine.current?.scrollIntoView({block: "center"});}, [file]);
  return <LinkContext.Provider value={links}><div ref={host} className="contents">
    {children}
    <Dialog.Root open={!!target} onOpenChange={open => {if (!open) setTarget(null);}}>
      <Dialog.Portal container={host.current}>
        <Dialog.Overlay className="chat-file-overlay" />
        <Dialog.Content className="shadcn-scope assistant-chat-scope chat-file-dialog" onCloseAutoFocus={event => {event.preventDefault(); trigger.current?.focus();}}>
          <header className="chat-file-heading">
            <Dialog.Title className="text-sm font-semibold">文件预览</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground break-all">{file?.path || target?.path}</Dialog.Description>
            <Dialog.Close className="chat-file-close" aria-label="关闭文件预览"><XIcon className="size-4" /></Dialog.Close>
          </header>
          {!loaded && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}
          {loaded?.error && <p role="alert" className="p-4 text-sm text-destructive">{loaded.error}</p>}
          {file && <>
            <p className="chat-file-meta">第 {file.start_line}–{file.start_line + file.lines.length - 1} 行，共 {file.total_lines} 行{file.line !== file.requested_line ? " · 引用行超出文件范围，已定位到末行" : ""}</p>
            <div className="chat-file-source" tabIndex={0} aria-label="文件内容">
              {file.lines.map((text, index) => {
                const line = file.start_line + index;
                return <div key={line} ref={line === file.line ? selectedLine : undefined} className="chat-file-line" data-selected={line === file.line || undefined}><span aria-hidden="true" className="chat-file-number">{line}</span><code>{text || " "}</code></div>;
              })}
            </div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div></LinkContext.Provider>;
}

export function ChatMarkdownLink({href, children, title}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const links = useContext(LinkContext);
  if (!href) return <span>{children}</span>;
  const file = fileReference(href);
  return <a href={file ? "#file-preview" : href} title={title || (file ? `${file.path}:${file.line}` : undefined)} className="aui-md-a text-primary hover:text-primary/80 underline underline-offset-2" target={file ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
    event.preventDefault();
    if (!links) return;
    if (file) links.open(file, event.currentTarget);
    else if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
      const url = new URL(href, window.location.href).href;
      const session = links.controller.getSnapshot().session?.id;
      void links.controller.options.request(`/api/sessions/${encodeURIComponent(session || "")}/open-link`, {method: "POST", body: JSON.stringify({url})}).catch(error => links.controller.setError((error as Error).message));
    }
  }} onAuxClick={event => event.preventDefault()}>{children}</a>;
}
