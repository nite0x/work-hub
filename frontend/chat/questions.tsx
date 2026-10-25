import {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import type {ChatController} from "./controller";
import {cleanText, type Approval, type Question, type QuestionDraft} from "./model";

function answerText(question: Question, draft?: QuestionDraft) {
  const choice = question.options?.find(option => option.label === draft?.choice)?.label;
  return [choice, draft?.text.trim()].filter(Boolean).join("\n\n");
}

// This form occupies the thread's composer slot. It replies to the pending RPC,
// rather than sending a user message or steering a turn past its question.
export function QuestionComposer({approval, controller}: {approval: Approval; controller: ChatController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const key = JSON.stringify([state.chat.id, approval.id]);
  const questions = approval.questions!;
  const [drafts, setDrafts] = useState(() => controller.questionDrafts.get(key) || {});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const question = questions[index];
  const draft = drafts[question.id] || {text: ""};
  const disabled = !!state.answering || state.stopping || !state.chat.busy || state.chat.status === "stopping";
  const completed = questions.filter(q => answerText(q, drafts[q.id])).length;
  const update = (patch: Partial<QuestionDraft>) => {
    const next = {...drafts, [question.id]: {...draft, ...patch}};
    setDrafts(next); controller.questionDrafts.set(key, next); setError("");
  };
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input:checked, input, textarea')?.focus();
  }, [index]);
  const submit = () => {
    if (disabled) return;
    const missing = questions.findIndex(q => !answerText(q, drafts[q.id]));
    if (missing >= 0) { setIndex(missing); setError("请回答这个问题，或跳过此次问询"); return; }
    const answers = Object.fromEntries(questions.map(q => [q.id, [answerText(q, drafts[q.id])]]));
    if (Object.values(answers).some(([value]) => new TextEncoder().encode(value).length > 8000)) {
      setError("每个回答最多 8000 字节，请缩短后提交"); return;
    }
    void controller.answer(approval, "accept", answers);
  };
  return <form ref={form} className="chat-question-composer" aria-label="回答 Codex 问询" onSubmit={event => {
    event.preventDefault(); submit();
  }} onKeyDown={event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault(); submit();
    }
  }}>
    <div className="chat-question-heading" aria-live="polite"><span>需要你的回答</span><span>{index + 1} / {questions.length}</span></div>
    {questions.length > 1 && <div className="chat-question-tabs" role="group" aria-label="切换问题">{questions.map((q, i) => <Button key={q.id} type="button" variant={i === index ? "secondary" : "ghost"} size="sm" aria-pressed={i === index} disabled={disabled} onClick={() => {setIndex(i); setError("");}}>{answerText(q, drafts[q.id]) && <CheckIcon aria-hidden="true" />}{cleanText(q.header) || `问题 ${i + 1}`}</Button>)}</div>}
    <fieldset key={question.id} disabled={disabled} className="chat-question-fields">
      <legend>{cleanText(question.question || question.header)}</legend>
      {!!question.options?.length && <div className="chat-question-options">{question.options.map((option, i) => <label key={option.label} className="chat-question-option" data-selected={draft.choice === option.label}>
        <input type="radio" name={`choice:${question.id}`} value={option.label} checked={draft.choice === option.label} onChange={() => update({choice: option.label})} />
        <span className="chat-question-option-number" aria-hidden="true">{i + 1}</span><span><strong>{cleanText(option.label)}</strong>{option.description && <span className="chat-question-option-description">{cleanText(option.description)}</span>}</span>
      </label>)}{question.isOther !== false && <label className="chat-question-option" data-selected={draft.choice === ""}>
        <input type="radio" name={`choice:${question.id}`} value="" checked={draft.choice === ""} onChange={() => {update({choice: ""}); form.current?.querySelector<HTMLElement>('[name^="text:"]')?.focus();}} />
        <span className="chat-question-option-number" aria-hidden="true">{question.options.length + 1}</span><span><strong>其他</strong><span className="chat-question-option-description">填写自己的回答</span></span>
      </label>}</div>}
      {question.isSecret
        ? <Input name={`text:${question.id}`} type="password" autoComplete="off" aria-label={`${question.question}（回答）`} value={draft.text} onChange={event => update({text: event.target.value})} placeholder="输入回答" />
        : <Textarea name={`text:${question.id}`} aria-label={`${question.question}（回答或补充）`} value={draft.text} onChange={event => update({text: event.target.value})} placeholder={draft.choice ? "补充说明（可选）…" : "输入你的回答…"} rows={2} maxLength={8000} />}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="chat-question-actions">
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void controller.answer(approval, "decline", {})}>跳过问询</Button>
      <div className="chat-question-navigation">
        {questions.length > 1 && <><Button type="button" variant="ghost" size="icon-sm" aria-label="上一个问题" disabled={disabled || index === 0} onClick={() => {setIndex(index - 1); setError("");}}><ChevronLeftIcon /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label="下一个问题" disabled={disabled || index === questions.length - 1} onClick={() => {setIndex(index + 1); setError("");}}><ChevronRightIcon /></Button></>}
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void controller.stop()}>停止本轮</Button>
        {index < questions.length - 1 ? <Button key="next" type="button" size="sm" disabled={disabled || !answerText(question, draft)} onClick={event => {event.preventDefault(); setIndex(index + 1); setError("");}}>下一题<ChevronRightIcon /></Button> : <Button key="submit" type="submit" size="sm" disabled={disabled}>{state.answering === approval.id ? "提交中…" : `提交回答${questions.length > 1 ? `（${completed}/${questions.length}）` : ""}`}<ArrowUpIcon /></Button>}
      </div>
    </div>
  </form>;
}
