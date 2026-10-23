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
small integration changes when updating from the registry. Other behavior and
Tailwind layout stay upstream.

`frontend/chat/panel.tsx` supplies the existing external-store runtime, history
pagination, task/project information, and application-specific approvals. Tool
entries are converted to the official args/result format in `chat/model.ts`;
messages, composer, tool disclosures and Markdown use the registry components.

Styles compile through `npm run chat:build`. `chat/style.css` contains only the
stylesheet imports, legacy mount bridge, and a scoped reset for components that
normally expect Tailwind Preflight. Do not add a global reset to the old pages.
