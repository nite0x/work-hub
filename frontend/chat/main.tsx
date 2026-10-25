import {createRoot, type Root} from "react-dom/client";
import {ChatController, conversationKey as key, type ChatOptions} from "./controller";
import {ChatPanel} from "./panel";
import "./style.css";

let root: Root | undefined;
let active: ChatController | undefined;
const controllers = new Map<string, ChatController>();
let mountSequence = 0;
export const bridge = {
  open(options: ChatOptions) {
    if (!root) root = createRoot(document.getElementById("assistantChatRoot")!);
    active?.disconnect();
    let controller = controllers.get(key(options));
    if (!controller) { controller = new ChatController(options); controllers.set(key(options), controller); }
    const current = controller;
    controller.options = {...options, created(session) {
      controllers.delete(key(options, null)); controllers.set(key(options, session.id), current);
      options.created(session);
    }};
    active = controller;
    root.render(<ChatPanel key={++mountSequence} controller={controller} />);
  },
  close() { active?.disconnect(); active = undefined; root?.render(null); },
  updateTask(task: ChatOptions['task']) {
    if (!active || !task || active.options.task?.id !== task.id) return;
    active.options.task = task;
    root?.render(<ChatPanel key={mountSequence} controller={active} />);
  },
  updateWorkspace(workspace: ChatOptions['workspace']) {
    if (!active) return;
    active.options.workspace = workspace;
    root?.render(<ChatPanel key={mountSequence} controller={active} />);
  },
  updateSession(session: NonNullable<ChatOptions['session']>) { active?.updateSession(session); },
};
