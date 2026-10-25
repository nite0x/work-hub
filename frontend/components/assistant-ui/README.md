# Official assistant-ui registry components

These files are copied from the official assistant-ui registry, rather than a
custom recreation of its UI. Imported on 2026-10-23, compatible with the locked
`@assistant-ui/react` 0.15.31 runtime. The upstream MIT license is in `LICENSE`.

Entry: https://r.assistant-ui.com/thread.json

Registry dependencies: `attachment`, `file`, `follow-up-suggestions`, `image`,
`markdown-text`, `reasoning`, `tooltip-icon-button`, `tool-fallback`, `tool-group`,
and `elements-collapsible-root` (all at `https://r.assistant-ui.com/{name}.json`).
Supporting hooks and utilities are also copied from those registry entries.
Missing shadcn UI dependencies use the official `new-york` registry; existing
project UI components are reused.

Local changes to `thread.aui.tsx` are limited to Chinese labels and retaining
Ctrl+Enter, the 32,000 character limit, disabled attachment paste, and hiding the
attachment control when the runtime has no attachment adapter. Keep those
small integration changes when updating from the registry. The application toolbar is composed separately in `frontend/chat/controls.tsx`;
message rendering and the composer retain the registry layout.

The thread uses a shared 56rem reading width for messages and the composer.
Short interactive conversations sit above the docked composer, keeping the
latest reply close to the input; history-only views retain top alignment.
Message spacing is reduced locally without changing scroll or runtime behavior.

The `readOnly` prop reuses the same message, Markdown and tool components for
explicit history-only mode, hiding the composer and suggestions. Both session
modes mount through the same chat bridge.

`frontend/chat/panel.tsx` supplies the existing external-store runtime, history
pagination, task/project information, and application-specific approvals. Tool
entries are converted to the official args/result format in `chat/model.ts`;
messages, composer, tool disclosures and Markdown use the registry components.

Styles compile through `npm run chat:build`. `chat/style.css` contains the stylesheet imports, legacy mount bridge, a scoped
Preflight reset, and compact application toolbar/overlay styles. Do not add a global reset to the old pages.

对话运行时继续复用 external-store：运行中发送按钮和 Ctrl/⌘+Enter 直接调用 composer.send，再由控制器发送原生 turn/steer；没有把下一轮队列伪装成当前轮次补充。未接入的编辑/重新生成操作不展示，工具分组及常用操作使用中文。上下文设置、整理会话和查找控件在 frontend/chat/controls.tsx，持久化草稿适配在 drafts.ts。


The conversation toolbar reuses the registry `TooltipIconButton` and shared
shadcn `Button`, `Badge`, `Input` and `NativeSelect` components. Application-only
settings and session management use Radix `Popover`, `DropdownMenu` and
`Collapsible`, matching the primitives used by the registry. These overlays
portal into the chat panel so they inherit its theme and remain interactive
inside the native conversation dialog. Escape dismisses overlays; editor and
search dismissal restore focus to their triggering controls. Running/approval
state stays in the toolbar; the footer is reserved for actionable notices and
errors. The session page omits its duplicate large heading to give the shared
browser and message viewport more space.


`Thread.composerControls` is an optional React node slot in the existing
`ComposerAction` row, next to attachments. Work Hub supplies its model/effort/mode
popover through that slot, keeping the registry composer and runtime intact.
The popover opens above the composer and portals into the chat panel. Read-only
history retains a header context control because it has no composer. Page scope
and execution-environment filters live in the conversation list; the environment
picker is hidden when the inventory contains only one environment.

`Thread.composer` replaces the composer in its existing viewport footer while a
structured `item/tool/requestUserInput` request is pending. Work Hub renders
`chat/questions.tsx` there with radio options, custom answers and multi-question
navigation. Replies use the pending request ID through the approval endpoint;
the normal message/attachment draft stays in the runtime and returns afterward.
Permission approvals and MCP forms retain their separate approval controls.
