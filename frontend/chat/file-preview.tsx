import {createContext, useCallback, useContext, useMemo, type AnchorHTMLAttributes, type HTMLAttributes, type PropsWithChildren} from "react";
import {useIsMarkdownCodeBlock} from "@assistant-ui/react-markdown";
import type {ChatController} from "./controller";
import {fileReference, sourceFileReference, type FileReference} from "./links";

const MarkdownAnchorContext = createContext(false);

const LinkContext = createContext<{controller: ChatController; open: (ref: FileReference) => void} | null>(null);

export function ChatFileProvider({controller, children}: PropsWithChildren<{controller: ChatController}>) {
  const open = useCallback((ref: FileReference) => {
    const session = controller.getSnapshot().session?.id;
    const event = new CustomEvent("workhub:open-file", {cancelable: true, detail: {...ref, session, environment: controller.options.environment}});
    if (window.dispatchEvent(event)) controller.setError("无法打开文件：请确认文件位于当前对话的工作目录或附加目录中");
  }, [controller]);
  const links = useMemo(() => ({controller, open}), [controller, open]);
  return <LinkContext.Provider value={links}>{children}</LinkContext.Provider>;
}

export function ChatFileButton({reference, children}: PropsWithChildren<{reference: FileReference}>) {
  const links = useContext(LinkContext);
  return <button type="button" className="chat-file-reference" title={`打开 ${reference.path}:${reference.line}`} disabled={!links} onClick={event => {event.preventDefault(); event.stopPropagation(); links?.open(reference);}}>{children}</button>;
}

export function ChatInlineCode({children, className, ...props}: HTMLAttributes<HTMLElement>) {
  const block = useIsMarkdownCodeBlock();
  const linked = useContext(MarkdownAnchorContext);
  const reference = !block && !linked && typeof children === "string" ? sourceFileReference(children) : null;
  return <code {...props} className={[!block ? "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]" : "",className].filter(Boolean).join(" ")}>{reference ? <ChatFileButton reference={reference}>{children}</ChatFileButton> : children}</code>;
}

export function ChatMarkdownLink({href, children, title}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const links = useContext(LinkContext);
  if (!href) return <span>{children}</span>;
  const file = fileReference(href);
  return <a href={file ? "#file-preview" : href} title={title || (file ? `${file.path}:${file.line}` : undefined)} className="aui-md-a text-primary hover:text-primary/80 underline underline-offset-2" target={file ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
    event.preventDefault();
    if (!links) return;
    if (file) links.open(file);
    else if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
      const url = new URL(href, window.location.href).href;
      const session = links.controller.getSnapshot().session?.id;
      void links.controller.options.request(`/api/sessions/${encodeURIComponent(session || "")}/open-link`, {method: "POST", body: JSON.stringify({url})}).catch(error => links.controller.setError((error as Error).message));
    }
  }} onAuxClick={event => event.preventDefault()}><MarkdownAnchorContext.Provider value={true}>{children}</MarkdownAnchorContext.Provider></a>;
}
