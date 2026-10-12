import { XIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { agentName } from '../../agents';
import { displayBinding, matches } from '../../shortcuts';
import { taskLabel } from '../../tasks';
import { type AgentId, NEW_SESSION, type ReviewMessage } from '../../types';
import { SUBMIT_KEY } from '@/components/DiffFooter';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { dropDraft, replyTo, resolveThread, retryMessage, sendComment } from '@/components/review-actions';
import { ReviewContext, type ReviewPane, sessionName } from '@/components/review-context';
import { SessionPicker } from '@/components/SessionPicker';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { DesignCommentsModel } from '@/hooks/use-design-comments';
import type { CommentSelection, CommentTab, PinRects } from '@/hooks/use-design-pins';
import { useReview } from '@/hooks/use-review';
import { type MessageKey, t, tPlural } from '@/i18n';
import { clockOf, type CommentState, type DesignComment, fileComments, targetOf } from '@/lib/design-comments';
import { taskRef } from '@/lib/operations-activity';
import { isMac } from '@/lib/shortcut-bindings';
import { STATUS_DOT } from '@/lib/status';

// The design pane's comments panel (#113): a design file's comments in the handoff's five states, their actions, and an inline box to reply
// or reopen. The pins on the canvas and the composer are #114's, beside the panel.

/** The pane's toggle groups (#109): a --card track, the checked item in --accent. */
export const TOGGLE_TRACK = 'shrink-0 rounded-md bg-card p-0.5';
export const TOGGLE_ITEM = 'h-5 px-1.5 text-xs data-[state=on]:bg-accent data-[state=on]:text-foreground';

type BoxMode = 'reply' | 'reopen';
interface Action { key: MessageKey; run(): void }
type Run = DesignCommentsModel['run'];

const SEND_KEY = 'CmdOrCtrl+Enter';
const STATE_DOT: Record<CommentState, string> = { draft: STATUS_DOT.empty, agent: STATUS_DOT.working, replied: STATUS_DOT.waiting, agentDone: STATUS_DOT.approval, resolved: STATUS_DOT.empty };
// The handoff's item backgrounds: --waiting and --approval at 8 %, the two states that wait on the user
const STATE_TINT: Partial<Record<CommentState, string>> = { replied: 'bg-waiting/8', agentDone: 'bg-approval/8' };
const SELECTED = 'bg-card shadow-[inset_2px_0_0_var(--foreground)]';
const PIN_TEXT = 'text-white';
const PIN_ON_WAITING = 'text-[#111418]'; // the handoff's pin text on --waiting
const isQuiet = (state: CommentState): boolean => state === 'draft' || state === 'resolved'; // the --empty states read muted

function wordOf(item: DesignComment, sessions: ReviewPane['sessions']): string {
  if (item.state === 'agent') return t('design.status.agent', { session: sessionName(item.session ?? NEW_SESSION, sessions) });
  if (item.state === 'resolved') return t(item.isConfirmed ? 'design.status.confirmed' : 'design.status.you');
  return t(`design.status.${item.state}`);
}

// enviar on a draft (#113): sent now as a conversation to the footer's recipient; the draft goes once the thread is stored, a refusal keeps
// it. The server pins every new thread (#111), so the sent comment takes the file's next pin
async function sendDraft(model: DesignCommentsModel, item: DesignComment): Promise<unknown> {
  const sent = await sendComment(model.taskId, { anchor: item.anchor, text: item.text, to: [model.recipient.session] });
  return sent === undefined ? undefined : dropDraft(model.taskId, item.id);
}

// reabrir (#113): resolve false drops resolved and the agent's mark, so the thread reads com o agente; a note then goes to its reply target
async function reopen(taskId: string, thread: string, note: string): Promise<unknown> {
  const done = await resolveThread(taskId, thread, false);
  return done === undefined || note === '' ? done : replyTo(taskId, thread, { text: note });
}

// The handoff's actions per state (#113): resolver and confirmar both resolve, which keeps an agent's mark (#111); reabrir and responder
// open the item's box
function actionsOf(item: DesignComment, model: DesignCommentsModel, run: Run, openBox: (mode: BoxMode) => void): Action[] {
  const { taskId } = model;
  const resolve = (): void => void run(() => resolveThread(taskId, item.id, true));
  if (item.state === 'draft') {
    return [{ key: 'design.action.delete', run: () => void run(() => dropDraft(taskId, item.id)) }, { key: 'design.action.send', run: () => void run(() => sendDraft(model, item)) }];
  }
  if (item.state === 'agent') return [{ key: 'design.action.resolve', run: resolve }];
  if (item.state === 'replied') return [{ key: 'design.action.reply', run: () => openBox('reply') }, { key: 'design.action.resolve', run: resolve }];
  if (item.state === 'agentDone') return [{ key: 'design.action.reopen', run: () => openBox('reopen') }, { key: 'design.action.confirm', run: resolve }];
  return [{ key: 'design.action.reopen', run: () => openBox('reopen') }];
}

function Pin({ item }: { item: DesignComment }) {
  return (
    <span className={`flex size-4 shrink-0 items-center justify-center rounded-full font-semibold text-[10px] ${STATE_DOT[item.state]} ${item.state === 'replied' ? PIN_ON_WAITING : PIN_TEXT}`}>
      {item.anchor.pin}
    </span>
  );
}

// #591's undelivered mark and its reenviar
function Undelivered({ onRetry }: { onRetry(): void }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-destructive">{t('review.notDelivered')}</span>
      <Button type="button" size="xs" variant="link" onClick={onRetry}>{t('review.resend')}</Button>
    </span>
  );
}

// A later message of the conversation (#113): you or the session, the time, the text
function LaterMessage({ message, sessions, mark }: { message: ReviewMessage; sessions: ReviewPane['sessions']; mark: ReactNode }) {
  const who = message.author === 'user' ? t('review.you') : sessionName(message.author.session, sessions);
  return (
    <div className="mt-2 rounded-md bg-card p-2">
      <p className="text-muted-foreground text-xs">{`${who} · ${clockOf(new Date(message.at))}`}</p>
      <p className="whitespace-pre-wrap text-[13px] leading-[19px]">{message.text}</p>
      {mark}
    </div>
  );
}

function StatusLine({ item, sessions, isBusy, actions }: { item: DesignComment; sessions: ReviewPane['sessions']; isBusy: boolean; actions: Action[] }) {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[item.state]}`} />
      <span className={`min-w-0 truncate ${isQuiet(item.state) ? 'text-muted-foreground' : 'text-foreground'}`}>{wordOf(item, sessions)}</span>
      <span className="ml-auto flex shrink-0 gap-1">
        {actions.map((a) => <Button key={a.key} type="button" size="xs" variant="outline" disabled={isBusy} onClick={a.run}>{t(a.key)}</Button>)}
      </span>
    </div>
  );
}

// The inline box (#113): the composer's look without its popover. ⌘↵ presses its button and esc closes it; responder needs a text, reabrir not
function InlineBox({ mode, onClose, onSubmit, isBusy }: { mode: BoxMode; onClose(): void; onSubmit(text: string): void; isBusy: boolean }) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []); // a ref, not autoFocus: the box opens on a click and the keys are for it
  const label = t(mode === 'reply' ? 'design.action.reply' : 'design.action.reopen');
  const canSubmit = !isBusy && (mode === 'reopen' || text.trim() !== '');
  const submit = (): void => { if (canSubmit) onSubmit(text.trim()); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (matches(event.nativeEvent, SEND_KEY, isMac())) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <fieldset aria-label={label} className="mt-2 min-w-0">
      <textarea
        ref={field} aria-label={label} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
        className="min-h-14 w-full resize-y rounded-md border bg-background px-2 py-1 text-[13px] leading-[19px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1 flex items-center">
        <span className="text-muted-foreground text-xs">{t('design.composer.cancel')}</span>
        <Button type="button" size="xs" className="ml-auto" disabled={!canSubmit} onClick={submit}>{label}</Button>
      </div>
    </fieldset>
  );
}

interface ItemProps { item: DesignComment; model: DesignCommentsModel; isSelected: boolean; isFromPin: boolean; isRemoved: boolean; box?: BoxMode; onSelect(): void; onBox(mode?: BoxMode): void }

// One comment (#113): pin, target and time; its text; every later message; the status line; the inline box. The panel runs one request at a
// time, then reads the file again, so a double click never sends a comment twice; the undelivered mark waits for that request too
function CommentItem({ item, model, isSelected, isFromPin, isRemoved, box, onSelect, onBox }: ItemProps) {
  const { run, isBusy } = model;
  const row = useRef<HTMLLIElement>(null);
  // A pin's click selects an item the list may hold out of view (#114); an item's own click is in view already
  useEffect(() => { if (isSelected && isFromPin) row.current?.scrollIntoView({ block: 'nearest' }); }, [isSelected, isFromPin]);
  const markOf = (message: ReviewMessage): ReactNode => (message.failed && !isBusy ? <Undelivered onRetry={() => void run(() => retryMessage(model.taskId, item.id, message.id))} /> : null);
  const [first, ...later] = item.messages;
  // The box closes only once the server took the request: a refusal (undefined) keeps it open with the typed text
  const submit = async (text: string): Promise<void> => {
    const done = await run(() => (box === 'reply' ? replyTo(model.taskId, item.id, { text }) : reopen(model.taskId, item.id, text)));
    if (done !== undefined) onBox(undefined);
  };
  return (
    <li ref={row} aria-current={isSelected ? 'true' : undefined} onPointerDownCapture={onSelect} className={`border-b px-3 py-2.5 ${isSelected ? SELECTED : STATE_TINT[item.state] ?? ''}`}>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Pin item={item} />
        <span title={targetOf(item.anchor)} className="min-w-0 flex-1 truncate font-mono">{targetOf(item.anchor)}</span>
        {isRemoved && <span className="shrink-0 text-muted-foreground">{t('design.removed')}</span>}
        {item.at !== undefined && <span className="shrink-0 tabular-nums">{clockOf(new Date(item.at))}</span>}
      </div>
      <p className={`mt-1 whitespace-pre-wrap text-[13px] leading-[19px] ${item.state === 'resolved' ? 'text-muted-foreground' : 'text-foreground'}`}>{item.text}</p>
      {first !== undefined && markOf(first)}
      {later.map((m) => <LaterMessage key={m.id} message={m} sessions={model.sessions} mark={markOf(m)} />)}
      <StatusLine item={item} sessions={model.sessions} isBusy={isBusy} actions={actionsOf(item, model, run, onBox)} />
      {box !== undefined && <InlineBox mode={box} onClose={() => onBox(undefined)} onSubmit={submit} isBusy={isBusy} />}
    </li>
  );
}

function PanelHeader({ tab, open, resolved, onTab, onHide }: { tab: CommentTab; open: number; resolved: number; onTab(next: CommentTab): void; onHide(): void }) {
  const hide = t('design.comments.hide');
  return (
    <div className="flex h-[26px] shrink-0 items-center border-b px-2">
      <ToggleGroup type="single" size="xs" aria-label={t('design.comments')} value={tab} onValueChange={(next) => { if (next === 'open' || next === 'resolved') onTab(next); }} className={TOGGLE_TRACK}>
        <ToggleGroupItem value="open" className={TOGGLE_ITEM}>{t('design.tab.open', { n: open })}</ToggleGroupItem>
        <ToggleGroupItem value="resolved" className={TOGGLE_ITEM}>{t('design.tab.resolved', { n: resolved })}</ToggleGroupItem>
      </ToggleGroup>
      <Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={hide} title={hide} onClick={onHide}><XIcon /></Button>
    </div>
  );
}

// The recipient line (#113): the session in focus, the user's pick, or the new session enviar opens, of the default agent
function recipientLine({ recipient, sessions, activity }: DesignCommentsModel, agent: AgentId): string {
  if (recipient.how === 'new') return t('design.send.new', { agent: agentName(agent), activity: taskRef(activity.task) });
  return t(recipient.how === 'picked' ? 'design.send.picked' : 'design.send.to', { session: sessionName(recipient.session, sessions) });
}

// The footer (#113): enviar {n} rascunhos ⌘⇧↵ across its width, over the recipient line, which opens the task's sessions to pick another
function SendFooter({ model }: { model: DesignCommentsModel }) {
  const agent = useContext(DefaultAgentContext);
  return (
    <div className="shrink-0 border-t bg-card p-2.5">
      <Button type="button" size="sm" className="w-full" disabled={model.isBusy} onClick={model.sendAll}>
        {tPlural('design.send.all', model.drafts, { n: model.drafts })}<span aria-hidden="true" className="opacity-70">{displayBinding(SUBMIT_KEY, isMac())}</span>
      </Button>
      <div className="mt-1.5 flex justify-center">
        <SessionPicker value={model.recipient.session} onChange={model.pick}><span className="text-muted-foreground">{recipientLine(model, agent)}</span></SessionPicker>
      </div>
    </div>
  );
}

/** The comments panel (#113): its tabs and ×, the list, one inline box open at a time. The tab and the selection are the pane's (#114),
 *  which its pins share; rects is the bridge's answer, a null one marks its item's target removed. SessionPicker and SessionLabel read
 *  the task's sessions and agents through ReviewContext; a design has no diff scope nor line box, so the pane's scope and edit are inert. */
export interface DesignCommentsProps {
  model: DesignCommentsModel; tab: CommentTab; selection?: CommentSelection; rects: PinRects;
  onTab(next: CommentTab): void; onSelect(id: string): void; onHide(): void;
}
export function DesignComments({ model, tab, selection, rects, onTab, onSelect, onHide }: DesignCommentsProps) {
  const [box, setBox] = useState<{ id: string; mode: BoxMode }>();
  const pane: ReviewPane = {
    taskId: model.taskId, scope: 'worktree', task: taskLabel(model.activity.task), review: model.review, sessions: model.sessions,
    defaultSession: model.recipient.session, refresh: model.refresh, edit: () => undefined, isSending: false, track: (request) => request,
  };
  const items = tab === 'open' ? model.open : model.resolved;
  return (
    <ReviewContext.Provider value={pane}>
      <aside aria-label={t('design.comments')} className="flex min-h-0 min-w-0 flex-col bg-background text-xs">
        <PanelHeader tab={tab} open={model.open.length} resolved={model.resolved.length} onTab={onTab} onHide={onHide} />
        <ol className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {items.map((item) => (
            <CommentItem
              key={item.id} item={item} model={model} isSelected={selection?.id === item.id} isFromPin={selection?.isFromPin === true} isRemoved={rects.get(item.id) === null} box={box?.id === item.id ? box.mode : undefined}
              onSelect={() => onSelect(item.id)} onBox={(mode) => setBox(mode === undefined ? undefined : { id: item.id, mode })}
            />
          ))}
        </ol>
        {tab === 'open' && model.drafts > 0 && <SendFooter model={model} />}
      </aside>
    </ReviewContext.Provider>
  );
}

/** The design tab's open count (#113, handoff §1): a pill before its ×, above zero only. Its own read of the review, so the count shows
 *  with the pane behind another tab too. ponytail: two reads per design tab, this and the pane's; lift the pane's count up to its tab if
 *  that ever shows */
export function DesignCountPill({ taskId, path }: { taskId: string; path: string }) {
  const { review } = useReview(taskId);
  const count = review === undefined ? 0 : fileComments(review, path).open.length;
  return count > 0 ? <span className="rounded-full bg-accent px-1.5 text-[11px] text-muted-foreground tabular-nums">{count}</span> : null;
}
