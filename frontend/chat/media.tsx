import {createContext, useContext, useEffect, useMemo, useState, type ImgHTMLAttributes, type PropsWithChildren} from "react";
import type {ImageMessagePartComponent} from "@assistant-ui/react";
import {MarkdownText} from "@/components/assistant-ui/elements/markdown-text";
import {Image} from "@/components/assistant-ui/elements/image";
import type {ChatController} from "./controller";
import type {Entry} from "./model";
import {ChatFileProvider, ChatMarkdownLink} from "./file-preview";
import {chatURLTransform} from "./links";

type Media = {refs: Map<string, string>; load: (ref: string) => Promise<string>};
const MediaContext = createContext<Media | null>(null);
export function ChatMediaProvider({controller, entries, children}: PropsWithChildren<{controller: ChatController; entries: Entry[]}>) {
  const refs = useMemo(() => new Map(entries.flatMap(e => Object.entries(e.local_images || {}))), [entries]);
  const load = useMemo(() => {
    const pending = new Map<string, Promise<string>>();
    return (ref: string) => {
      if (!pending.has(ref)) {
        const session = controller.getSnapshot().session?.id;
        const request = controller.options.request<{data_url: string}>(`/api/sessions/${encodeURIComponent(session || "")}/image?ref=${encodeURIComponent(ref)}`).then(data => {
          if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(data.data_url)) throw new Error("图片格式不受支持");
          return data.data_url;
        }).catch(error => {pending.delete(ref); throw error;});
        if (pending.size >= 64) pending.delete(pending.keys().next().value!);
        pending.set(ref, request);
      }
      return pending.get(ref)!;
    };
  }, [controller]);
  const value = useMemo(() => ({refs, load}), [refs, load]);
  return <MediaContext.Provider value={value}><ChatFileProvider controller={controller}>{children}</ChatFileProvider></MediaContext.Provider>;
}
function useLocalImage(source: string) {
  const media = useContext(MediaContext);
  let decoded = source; try {decoded = decodeURI(source);} catch { /* Keep the literal source. */ }
  const ref = media?.refs.get(source) || media?.refs.get(decoded);
  const [loaded, setLoaded] = useState<{ref?: string; image?: string; error?: boolean}>({});
  useEffect(() => {
    if (!ref || !media) return;
    let current = true;
    void media.load(ref).then(image => {if (current) setLoaded({ref, image});}, () => {if (current) setLoaded({ref, error: true});});
    return () => {current = false;};
  }, [ref, media?.load]);
  return {ref, ...(loaded.ref === ref ? loaded : {})};
}
function ChatMarkdownImage({src, alt, title}: ImgHTMLAttributes<HTMLImageElement>) {
  const source = typeof src === "string" ? src : "";
  const local = source.startsWith("/") || /^[a-z]:[\\/]/i.test(source);
  const loaded = useLocalImage(source);
  if (!local) return <img src={source || undefined} alt={alt} title={title} className="max-w-full rounded-lg" loading="lazy" />;
  if (loaded.error || !loaded.ref) return <span className="chat-image-unavailable text-xs text-muted-foreground">{alt || "图片"} · 图片不存在、已移动或暂不可读取</span>;
  if (!loaded.image) return <span className="text-xs text-muted-foreground" role="status">正在加载{alt || "图片"}…</span>;
  return <img src={loaded.image} alt={alt} title={title} className="chat-history-image max-w-full rounded-lg" loading="lazy" />;
}
const markdownComponents = {img: ChatMarkdownImage, a: ChatMarkdownLink};
export function ChatMessageText() {return <MarkdownText components={markdownComponents} urlTransform={chatURLTransform} />;}
export const ChatUserImage: ImageMessagePartComponent = props => {
  const loaded = useLocalImage(props.image);
  if (/^data:image\//.test(props.image)) return <Image {...props} />;
  if (loaded.error) return <span className="text-xs text-muted-foreground">图片不存在或已移动</span>;
  return loaded.image ? <Image {...props} image={loaded.image} /> : <span className="text-xs text-muted-foreground">正在加载图片…</span>;
};
