import {createRoot, type Root} from "react-dom/client";
import {ChatController, type ChatOptions} from "./controller";
import {ChatPanel} from "./panel";
import "./style.css";

let root: Root | undefined;
let active: ChatController | undefined;
const controllers = new Map<string, ChatController>();
let mountSequence = 0;
const key = (options: ChatOptions, session = options.session?.id || "new") => JSON.stringify([options.environment, options.task.id, session]);
export const bridge = {
  open(options: ChatOptions) {
    if (!root) root = createRoot(document.getElementById("assistantChatRoot")!);
    active?.disconnect();
    let controller = controllers.get(key(options));
    if (!controller) { controller = new ChatController(options); controllers.set(key(options), controller); }
    const current = controller;
    controller.options = {...options, created(session) {
      controllers.delete(key(options, "new")); controllers.set(key(options, session.id), current);
      options.created(session);
    }};
    active = controller;
    root.render(<ChatPanel key={++mountSequence} controller={controller} />);
  },
  close() { active?.disconnect(); active = undefined; root?.render(null); },
  updateTask(task: ChatOptions['task']) {
    if (!active || active.options.task.id !== task.id) return;
    active.options.task = task;
    root?.render(<ChatPanel key={mountSequence} controller={active} />);
  },
};
