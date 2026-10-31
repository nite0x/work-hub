import {createContext, Fragment, useContext, useMemo, useState} from "react";
import {useAuiState, type ToolCallMessagePartComponent} from "@assistant-ui/react";
import {ChevronDownIcon, FileDiffIcon} from "lucide-react";
import {ToolFallback} from "@/components/assistant-ui/elements/tool-fallback.aui";
import {FileTypeIcon} from "@/components/file-type-icon";
import {ChatFileButton} from "./file-preview";
import {sourceFileReference} from "./links";
import {changePathLabel, summarizeFileChanges, type FileChangePaths} from "./change-summary";

const ChangePathsContext = createContext<FileChangePaths>({projectRoots: []});
export const ChatChangePathsProvider = ChangePathsContext.Provider;

function ChangeCounts({additions, deletions}: {additions: number; deletions: number}) {
  return <span className="chat-change-counts" aria-label={`新增 ${additions} 行，删除 ${deletions} 行`}><span className="chat-change-added">+{additions}</span><span className="chat-change-deleted">-{deletions}</span></span>;
}

export function ChatChangeSummary() {
  const content = useAuiState(state => state.message.content);
  const paths = useContext(ChangePathsContext);
  const files = useMemo(() => summarizeFileChanges(content), [content]);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!files.length) return null;
  const allOpen = files.every(file => expanded.includes(file.path));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return <section className="chat-change-summary" aria-label="本轮修改的文件" title="根据本轮成功的文件修改记录累计增删行数">
    <header className="chat-change-heading">
      <span className="chat-change-icon"><FileDiffIcon aria-hidden="true" /></span>
      <div className="chat-change-title"><strong>已编辑 {files.length} 个文件</strong><ChangeCounts additions={additions} deletions={deletions} /></div>
      <button type="button" className="chat-change-view" aria-expanded={allOpen} onClick={() => setExpanded(allOpen ? [] : files.map(file => file.path))}>{allOpen ? "收起变更" : "查看变更"}</button>
    </header>
    <ul className="chat-change-files">{files.map(file => {
      const open = expanded.includes(file.path);
      const {label, fullPath} = changePathLabel(file.path, paths);
      const slash = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\"));
      return <li key={file.path}>
        <button type="button" className="chat-change-file" title={fullPath} aria-expanded={open} onClick={() => setExpanded(current => open ? current.filter(path => path !== file.path) : [...current, file.path])}>
          <ChevronDownIcon aria-hidden="true" className={open ? "is-open" : ""} />
          <FileTypeIcon path={file.path} />
          <span className="chat-change-path"><span>{label.slice(0, slash + 1)}</span>{label.slice(slash + 1)}</span>
          <ChangeCounts additions={file.additions} deletions={file.deletions} />
        </button>
        {open && <div className="chat-change-preview">
          <div className="chat-change-preview-heading"><span>本轮变更记录{file.patches.length > 1 ? ` · ${file.patches.length} 次修改` : ""}</span><ChatFileButton reference={{path: file.path, line: file.line}}>打开文件</ChatFileButton></div>
          {file.patches.length ? file.patches.map((patch, index) => <pre key={index} tabIndex={0} aria-label={`${file.path} 第 ${index + 1} 次修改的差异`}>{patch.split("\n").map((line, lineIndex) => <span key={lineIndex} className={line.startsWith("+") ? "chat-diff-added" : line.startsWith("-") ? "chat-diff-deleted" : line.startsWith("@@") ? "chat-diff-hunk" : undefined}>{line || " "}</span>)}</pre>) : <p>此文件没有可显示的文本差异，或差异预览已达到长度上限。</p>}
        </div>}
      </li>;
    })}</ul>
  </section>;
}

export function changedLine(lines: string[]) {
  let current = 0;
  let first: number | undefined;
  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { current = Math.max(1,Number(hunk[1])); first ??= current; continue; }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) return current;
    if (line.startsWith(" ")) current++;
  }
  return first || 1;
}

function ChangeText({text}: {text: string}) {
  const lines = text.split("\n");
  const headers = lines.flatMap((label,index) => {
    if (/^[+\-@ ]|^\\ /.test(label)) return [];
    const reference = sourceFileReference(label);
    return reference ? [{index,reference,label}] : [];
  });
  const links = new Map(headers.map((header,index) => [header.index,{
    ...header.reference,
    line: /(?:#L?\d+|:\d+(?:-\d+)?(?::\d+)?)$/i.test(header.label) ? header.reference.line : changedLine(lines.slice(header.index+1,headers[index+1]?.index)),
  }]));
  return <pre className="aui-tool-fallback-args-value bg-muted/50 text-foreground/90 rounded-md p-2.5 text-xs break-words whitespace-pre-wrap">{lines.map((line,index) => <Fragment key={index}>{links.has(index) ? <ChatFileButton reference={links.get(index)!}>{line}</ChatFileButton> : line}{index<lines.length-1?"\n":""}</Fragment>)}</pre>;
}

export const ChatToolFallback: ToolCallMessagePartComponent = props => {
  if (typeof props.args?.changes !== "string" || props.approval || props.status?.type === "requires-action") return <ToolFallback {...props} />;
  return <ToolFallback.Root>
    <ToolFallback.Trigger toolName={props.toolName} status={props.status} responseDeliveryStatus={props.responseDeliveryStatus} />
    <ToolFallback.Content>
      <ToolFallback.Error status={props.status} />
      <div className="aui-tool-fallback-args"><ChangeText text={props.args.changes} />{typeof props.args.cwd === "string" && <p className="text-xs text-muted-foreground break-all">工作目录 · {props.args.cwd}</p>}</div>
      <ToolFallback.Result result={props.result} />
    </ToolFallback.Content>
  </ToolFallback.Root>;
};
