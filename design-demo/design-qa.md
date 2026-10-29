# Design demo verification

final result: passed

## Target and scope

Extract the existing Work Hub task workflow into an interactive, local design
preview. Reuse the current repository's `TaskList`, `TaskDetail`, `TaskActions`,
`Projects`, UI primitives, styles, logo and icons. Use mock data and demo-only
style overrides. This is a design sandbox, not a pixel-identical copy of the
older binary currently serving port 43219, and not a backend integration test.

## Visual evidence

Evidence directory:
`C:/Users/xcq18344/.codex/visualizations/2026/10/28/work-hub-design/`

- Source visual truth: `source-detail.png`, captured from the running Work Hub
  task detail at port 43219.
- Initial implementation: `demo-detail.png`.
- Final implementation: `demo-detail-final.png`.
- Full-view comparison: `comparison-final.png` (source left, demo right).
- Focused comparison: `comparison-rows-final.png` (source row above, demo below).
- Design panel: `demo-design-panel.png`.

The source and final task-detail captures are each 1280 × 720 physical pixels
at a 1280 × 720 CSS viewport, density 1. No rescaling was used in the combined
2560 × 720 comparison. The focused comparison crops the project row from each
capture without rescaling. The panel capture is 1304 × 902 at density 1.
The detail comparison uses the same task-workspace view with sidebar expanded.
The demo deliberately includes a third, missing directory and richer mock
upstream state. The captured demo uses the saved purple theme, 6px radius and
compact density; the running source uses its own original theme.

## Findings and comparison history

1. **P2, fixed — design panel centered over the main content.** Existing important
   Tailwind positioning utilities outranked the initial unlayered overrides.
   Moved the panel overrides into the established CSS layer cascade. The final
   panel capture shows a 380px panel at the right with the underlying page still
   visible and usable; the panel closes and scrolls independently.
2. **P2, fixed — excessive task-detail header space.** The initial breadcrumb,
   separate back link and subtitle pushed work directories too far down.
   Combined back navigation and design controls, and omitted the extra subtitle
   on task details. `demo-detail.png` records the earlier state;
   `demo-detail-final.png` and `comparison-final.png` record the corrected state.
3. **Fixed — development hot updates created duplicate React roots.** Retained
   the entry root in Vite's hot-module data. A fresh verification tab and its
   subsequent hot update reported zero console errors or warnings.
4. **Fixed — shared fixture directory statuses conflicted.** Assigned separate
   paths and branches to the initial tasks, keeping project views consistent
   with task views. The project page now reports both changed and missing
   directories and links them back to the appropriate tasks.

No remaining actionable P0/P1/P2 visual findings within the desktop preview
scope. This pass accepts the deliberate mock-content differences, the added
design control and simulated operations. System terminals, real Git commands
and production-state parity are outside this demo's scope.

## Required fidelity surfaces

- **Fonts and typography:** inherited the existing Chinese/system font stack,
  title hierarchy, branch monospace text and UI component typography. Checked
  readable labels, project names, paths and action alignment in the focused row
  comparison; no clipping in the inspected desktop states.
- **Spacing and layout:** retained sidebar/content structure, list separators,
  goal section and project action grouping. Reduced header drift. Verified
  desktop document width does not exceed the viewport and keyboard resizing
  changes the project-list separator from 248px to 268px.
- **Colors and tokens:** inherited original surfaces, borders and semantic state
  colors. Verified theme and radius changes visibly affect the demo; custom
  preferences use an isolated storage key. Selected theme differences are an
  explicit design-control setting, not accidental drift.
- **Images and assets:** used the repository's actual Work Hub SVG logo and
  existing Lucide icons. No recreated raster logos or generated placeholders.
- **Copy and content:** retained component-owned workflow wording. Names,
  directory paths, dates, Git statuses and diffs are clearly simulated; the
  design label and footer identify the sandbox.

## Interaction verification

Browser-tested using the in-app browser:

- Task list, task-detail navigation and hash routing.
- Search with no matches and its empty-state actions.
- Create a task with a project; verify entry into its new detail view.
- Edit task name and verify the updated heading.
- Filter missing directories, replace a directory, and verify the issue count
  changes from one to zero with the filtered empty state.
- Theme, radius, offline scenario and restore-default controls.
- Project selection and the affected project heading/work directories.
- Project-directory issue filtering.
- Keyboard resizing of the project-list separator.
- Fresh-tab browser error/warning log: empty.

## Build verification

- `npm run check`: passed.
- `npm run build`: passed. After adding the actual chat UI, Vite reports a
  non-blocking bundle-size advisory for the approximately 1.06 MB uncompressed
  demo JS chunk (320 KB gzip). This local sandbox is not a production bundle.
- Output is isolated in `design-demo/dist/`.
- No production entrypoint, backend route, real repository or desktop launch
  command was changed for the demo.

## Remaining coverage

- Phone-size viewports and all platform/browser combinations were not tested.
- System actions show simulated feedback; real execution is intentionally absent.
- Design preferences persist; demo task edits reset on full page refresh or
  scenario reset, as documented in the README.

## Conversation page addition

final result: passed

Added `#/sessions`, task scopes (`#/sessions/task/<id>`) and project scopes
(`#/sessions/project/<id>`). The production `ConversationList`, assistant-ui
`Thread`, message renderer, markdown and composer are reused with an in-memory
external-store adapter. No production chat controller, API, provider or draft
storage is called by the demo.

### Comparison evidence

In the same evidence directory:

- Source: `source-conversation.png`, actual Work Hub conversation page.
- Final: `demo-conversation.png`.
- Combined full-view: `comparison-conversation.png`, source left, demo right.
- Focused input comparison: `comparison-composer.png`, source above, demo below.
- Narrow desktop: `demo-conversation-narrow.png`.

Source and final are 1280 × 720 pixels at 1280 × 720 CSS pixels and density 1;
the combined image is 2560 × 720. Input crops are not rescaled. The narrow
capture is 784 × 902 CSS/physical pixels, density 1, with sidebar collapsed.
Compared the same conversation-browser view, selected history and idle input
state. Mock text, saved theme, number of conversations, demo toolbar and absence
of real provider controls are intentional differences. The running source's
fixture model-list error is not reproduced as a demo error.

### Findings, fix and repeat check

- **P1, fixed:** the standalone thread root initially measured 0px wide inside
  the new flex wrapper, so messages and composer were not visible. Changed the
  wrapper to a column and explicitly let the thread root fill available width.
  Final browser measurements show a 682px thread and a normal 37.5px input at
  1280px viewport width. Final full-view and focused evidence show the fix.
- During that initial zero-width render the input autosized to its maximum.
  Fresh-load verification after the width fix confirms normal sizing on both
  inspected desktop widths, without horizontal document overflow at 784px.
- No remaining actionable P0/P1/P2 findings in the inspected conversation states.

### Fidelity surfaces

- Typography: inherited the actual markdown, user-message bubble, composer and
  list typography; checked wrapping at wide and narrow desktop widths.
- Layout: retained list/detail split, context header, scrollable history and
  bottom input. Composer remains reachable and its controls do not overflow.
- Tokens: existing neutral surfaces and saved demo theme are preserved; compact
  density also adjusts conversation-list row spacing.
- Assets: reused existing logo and Lucide icons; no replacement illustrations.
- Copy: mock user/assistant messages are task-focused; input hint comes from the
  real composer; the footer and composer clearly identify simulated replies.

### Browser interaction checks

- Send a message; see running state, then a mock assistant reply.
- New conversation with task/project selection; see the empty welcome state.
- Stop a pending reply; verify stopped text, idle input and no late mock reply.
- Search with no matches, then clear the search.
- Switch conversations; confirm the test message does not appear in another
  thread (`containsOtherThread: false`).
- Navigate from task detail through its conversation action; verify task-scoped
  URL, scope label and conversation count.
- Retain selected conversation histories while navigating within the demo.
- Final fresh-tab console: zero errors/warnings.
- Type check and production build passed after the final changes.

Phone-sized viewports, actual model replies, provider configuration and file
attachments remain outside this verification. Refresh restores mock messages;
switching between demo pages retains them for the current browser page session.
