import { useEffect } from 'react';
import { activityOf, resultOf, workIdOf } from '../../activities';
import { taskLabel } from '../../tasks';
import { FIXED_BINDINGS } from '../../shortcuts';
import type { Task, TaskFile, State } from '../../types';
import { DETAIL_OUTLINE } from '@/components/ApprovalActions';
import { DetailMenu } from '@/components/DetailMenu';
import { CheckpointsList } from '@/components/CheckpointsList';
import { BlockersSection } from '@/components/BlockersSection';
import { CiNotice } from '@/components/CiProgress';
import { isStartFailure } from '@/components/CommandsProgress';
import { RunningBlock } from '@/components/RunningBlock';
import { SyncBlock } from '@/components/ForkSyncNotice';
import { ExhaustedBlock, TriesSection } from '@/components/TriesBlocks';
import { MetaGrid, ResultsList, SessionsList, StatusBox } from '@/components/DetailSections';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { StartFailure } from '@/components/StartFailure';
import { Button } from '@/components/ui/button';
import { useTaskFiles } from '@/hooks/use-task-files';
import { type CommentsState, useComments } from '@/hooks/use-comments';
import type { CenterMode } from '@/hooks/use-activity';
import { t } from '@/i18n';
import { isExhausted } from '@/lib/task-state';

/** The task Detalhes shows. `fromActivity` (#457): picked through the Activities tab, so Detalhes follows it without opening its panel. */
export interface Selection { taskId: string; fromActivity?: true }

/** Where Detalhes sits (redesign 06), from MainDock: the center's mode picks the Atividades variant, and the footer's first button opens the
 * task's activity (only while it runs) or goes back to the flow. */
export interface DetailNav { center: CenterMode; canOpenActivity(taskId: string): boolean; openActivity(taskId: string): void; showFlow(): void }

// isShown: Detalhes is the shown tab of an open panel; onClose closes the panel holding it (#452). MainDock hands both, and `nav`.
interface DetailPanelProps { state: State; selected?: Selection; locale: string; isShown: boolean; onClose(): void; nav?: DetailNav }

const MUTED = 'text-muted-foreground text-xs';

interface BodyProps { task: Task; state: State; comments: CommentsState; files: TaskFile[]; locale: string; isActivity: boolean }

// Hidden on a source without comments; a failure stays here and never blanks the task data above it.
function Comments({ comments, locale }: { comments: CommentsState; locale: string }) {
  if (comments.kind === 'unsupported') return null;
  return (
    <section aria-label={t('detail.comments')} className="flex flex-col gap-2 border-t pt-2">
      <h4 className="font-medium text-xs">{t('detail.comments')}</h4>
      {comments.kind === 'loading' && <p className={MUTED}>{t('detail.loading')}</p>}
      {comments.kind === 'error' && <p className="text-destructive text-xs">{t('detail.commentsError', { message: comments.message })}</p>}
      {comments.kind === 'list' && comments.comments.length === 0 && <p className={MUTED}>{t('detail.noComments')}</p>}
      {comments.kind === 'list' && comments.comments.map((c) => (
        <article key={c.url} className="flex flex-col gap-1">
          <a href={c.url} target="_blank" rel="noreferrer" className={MUTED}>{`${c.author} · ${new Date(c.createdAt).toLocaleString(locale)}`}</a>
          <IssueMarkdown text={c.body} />
        </article>
      ))}
    </section>
  );
}

// The one status block (#914, #916): out of tries, the exhausted block; a wait for CI or a commands stage in flight, the running block; else the
// status box
function StatusBlock({ task, state, locale, isActivity }: { task: Task; state: State; locale: string; isActivity: boolean }) {
  const live = activityOf(state, task.item.itemId);
  if (isExhausted(task, state)) return <ExhaustedBlock task={task} state={state} locale={locale} />;
  if (live?.ci !== undefined || live?.commands !== undefined) return <RunningBlock task={task} state={state} />;
  return <StatusBox task={task} state={state} isActivity={isActivity} />;
}

// The scrolling body (redesign 06), with no visible bar and 14px under its last line (#57): the title, the task's error in full (a failed
// start's short message, its raw text behind details, #945), which the flow's chip truncates (#482), the status block (the status box, the
// running block while a wait for CI or a commands stage runs, #914, or the exhausted block once the tries ran out, #916) and the tries
// section under it, the blockers (#57), the metadata, the sessions and what the task produced, then behind a divider the issue and its comments.
function TaskBody({ task, state, comments, files, locale, isActivity }: BodyProps) {
  const { item } = task;
  const live = activityOf(state, item.itemId); // the activity's (#629)
  const error = live?.error; // #916: not shown while the exhausted block says it in words
  return (
    <div className="scrollbar-none flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3.5">
      <h2 className="break-words font-semibold text-[15px] text-foreground leading-5">{taskLabel(task)}</h2>
      {error && !isExhausted(task, state) && (isStartFailure(error)
        ? <StartFailure error={error} /> // #945: the short message, the raw text behind details
        : <p role="alert" className="whitespace-pre-wrap break-words text-destructive text-xs">{error}</p>)}
      <StatusBlock task={task} state={state} locale={locale} isActivity={isActivity} />
      <TriesSection task={task} state={state} />
      <SyncBlock task={task} state={state} />
      <CiNotice task={task} state={state} />
      <BlockersSection key={item.itemId} task={task} state={state} />
      <MetaGrid task={task} state={state} isActivity={isActivity} />
      <SessionsList task={task} state={state} locale={locale} />
      <CheckpointsList task={task} state={state} />
      <ResultsList task={task} files={files} />
      <div className="flex flex-col gap-3.5 border-t pt-3.5 text-[13px] leading-5">
        {item.body.trim() === '' ? <p className="text-muted-foreground">{t('detail.noBody')}</p> : <IssueMarkdown text={item.body} />}
        <Comments comments={comments} locale={locale} />
      </div>
    </div>
  );
}

// The panel's footer (redesign 06), fixed under the scrolling body: in the flow, abrir atividade, enabled while the task runs; under
// Atividades, ver no fluxo, back to the flow; then ⋯ (DetailMenu).
function TaskFooter({ task, state, nav }: { task: Task; state: State; nav?: DetailNav }) {
  const id = task.item.itemId;
  return (
    <div data-slot="detail-footer" className="flex shrink-0 items-center gap-2 border-t p-3">
      {nav?.center === 'activities' && <Button type="button" variant="outline" size="sm" className={DETAIL_OUTLINE} onClick={nav.showFlow}>{t('detail.showFlow')}</Button>}
      {nav?.center === 'automation' && (
        <Button type="button" variant="outline" size="sm" className={DETAIL_OUTLINE} disabled={!nav.canOpenActivity(id)} onClick={() => nav.openActivity(id)}>{t('detail.openActivity')}</Button>
      )}
      <DetailMenu task={task} state={state} />
    </div>
  );
}

// A key that belongs to something else: a text field keeps it, and a terminal's goes to its pty, where Escape interrupts Claude Code (#426).
// Exported for the flow's focus (#35), whose Esc skips the same targets
export const OWNS_ESCAPE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [data-terminal-find]';

// Escape is a fixed key (#481) and no binding, since normalizeBinding refuses it, so it is read off the event: alone, as it always closed the panel.
const isCloseKey = (event: globalThis.KeyboardEvent): boolean =>
  event.key === FIXED_BINDINGS.closePanel && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

/** Escape (#426, fixed since #481) closes the panel holding Detalhes wherever the focus is (#452), while Detalhes is its shown tab: on the
 * document, since a task opened from the flow leaves the focus there and a click on the panel's text leaves it on body. A confirm, dialog
 * or menu that closed itself on the key has already called preventDefault. The selection stays, so the task is there when the panel opens
 * again. */
function useClosePanelKey(isShown: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!isShown) return undefined;
    const listener = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !isCloseKey(event)) return;
      if (event.target instanceof Element && event.target.closest(OWNS_ESCAPE)) return;
      onClose();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [isShown, onClose]);
}

/** The task's expanded view (#283, #304), the body of the dock's Detalhes tab (#342), which is always there (#452): with no task selected,
 * or one App has not dropped yet after it left the Hive, it shows an empty state. The dock draws its tab, its panel's X, its divider and its
 * size. A docked panel is no dismissable layer, so a click elsewhere never closes it (the #184 guard is gone). */
export function DetailPanel({ state, selected, locale, isShown, onClose, nav }: DetailPanelProps) {
  const task = state.tasks.find((c) => c.item.itemId === selected?.taskId);
  const comments = useComments(task?.item.itemId); // once per task
  // once per task too (#258): its live activity's id, else its newest record's, after a delete (#629); again when a stage adds a result (#662)
  const files = useTaskFiles(task && workIdOf(state, task.item.itemId), JSON.stringify(task ? resultOf(state, task.item.itemId) ?? null : null));
  useClosePanelKey(isShown, onClose);
  // A plain paragraph, not the task's aside: "no complementary" still means no task is shown
  if (!task) return <p className="p-4 text-muted-foreground text-sm">{t('detail.empty')}</p>;
  const isActivity = nav?.center === 'activities';
  return (
    <aside aria-label={t('detail.title')} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <TaskBody task={task} state={state} comments={comments} files={files} locale={locale} isActivity={isActivity} />
      <TaskFooter task={task} state={state} nav={nav} />
    </aside>
  );
}
