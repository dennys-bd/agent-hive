import { toast } from 'sonner';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { liveRuns, openFeedbackSession, startMode } from '../../task-runs';
import { activityOf, prsOf, recordWithSession, workIdOf } from '../../activities';
import { taskTotals } from '../../record-kit';
import { continuable, SESSION_ID_CHARS, sessionsOf, workersOf } from '../../tasks';
import { prGroups, prNumber, repoName, type PrGroup, type PrLine } from '../../pull-requests';
import type { Task, TaskFile, Session, OpenResult, State } from '../../types';
import type { TaskState } from '@/lib/status';
import { baseText } from '@/components/ForkSyncNotice';
import { act, actThen, attachRun } from '@/components/actions';
import { ApprovalActions } from '@/components/ApprovalActions';
import { CommandsLine } from '@/components/CommandsProgress';
import { RestartDialog } from '@/components/RestartDialog';
import { useOpenFile, useOpenPr, useOpenRun, useOpenStarted } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { statusText, t } from '@/i18n';
import { sessionPath } from '@/lib/copy-targets';
import { isMarkdownPath } from '@/lib/doc-links';
import { answerableActivity, backoffUntil, createsIssues, taskState } from '@/lib/task-state';
import { backoffLabel, clock, compact, fmt } from '@/lib/usage';
import { shownSize } from '@/lib/xterm-setup';

const MUTED = 'text-muted-foreground';

// Literal per-status strings, as STATUS_BORDER's, so Tailwind sees each class: the border in the status colour and the fill at 12%
const STATUS_BOX: Record<TaskState, string> = {
  new: 'border-empty bg-empty/12',
  empty: 'border-empty bg-empty/12', working: 'border-working bg-working/12', waiting: 'border-waiting bg-waiting/12',
  review: 'border-review bg-review/12', approval: 'border-approval bg-approval/12', backoff: 'border-backoff bg-backoff/12',
};
const STATUS_WORD: Record<TaskState, string> = {
  new: 'text-muted-foreground',
  empty: 'text-muted-foreground', working: 'text-working', waiting: 'text-waiting', review: 'text-review', approval: 'text-approval', backoff: 'text-backoff',
};

// Under Atividades, each live session of the task: its short id, how long it has run and its tokens so far
function RunLines({ task, state }: { task: Task; state: Work }) {
  const now = Date.now();
  return workersOf(state, task).filter((worker) => worker.sessionId !== undefined).map((worker) => {
    const age = worker.startedAt === undefined ? [] : [t('detail.ago', { time: compact(now - Date.parse(worker.startedAt)) })];
    const parts = [worker.sessionId?.slice(0, SESSION_ID_CHARS), ...age, `${fmt(worker.tokens ?? 0)} tokens`];
    return <p key={worker.id} className={`${MUTED} text-xs`}>{parts.join(' · ')}</p>;
  });
}

// continuar and reiniciar etapa… on a task whose stage can go on and nothing runs (#580): the task's button and the task menu's item,
// offered under the conditions their routes answer (no live run on the task, none on the stage's session). The dialog outlives the
// buttons: its restart takes a worker at once, which hides them before its answer hands the task over (#457)
function StoppedActions({ task, state }: { task: Task; state: State }) {
  const [isRestarting, setIsRestarting] = useState(false);
  const opener = useOpenStarted();
  const mode = startMode(task, state);
  const offer = typeof mode === 'object' && mode.live === undefined && liveRuns(task, state).length === 0 ? mode : undefined;
  const started = (): void => opener?.(task.item.itemId);
  const work = `/activities/${encodeURIComponent(workIdOf(state, task.item.itemId) ?? '')}`; // the live activity, else a deleted one's record a continue resumes from (#629)
  return (
    <>
      {offer && (
        <div className="flex gap-1.5">
          {offer.continue && <Button type="button" size="xs" onClick={() => void actThen(`${work}/continue`, started, { size: shownSize() })}>{t('task.continue')}</Button>}
          {offer.restart && (
            <Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setIsRestarting(true)}>
              {t('task.restartStage')}
            </Button>
          )}
        </div>
      )}
      {isRestarting && <RestartDialog task={task} state={state} onStarted={started} onClose={() => setIsRestarting(false)} />}
    </>
  );
}

/** The status box (redesign 06): the status word and the stage, then under Atividades the running sessions, and while the approval is the
 * user's to answer its actions (#268, #829: never while a session of the task works, waits or backs off; the user answers there), keyed by
 * `since` so a new stage end mounts an empty feedback box; on a stopped task the time since the stop, continuar and reiniciar etapa… (#580). */
export function StatusBox({ task, state, isActivity }: { task: Task; state: State; isActivity: boolean }) {
  const status = taskState(task, state); // the task's state (#663): parada with its since-time when empty
  const live = activityOf(state, task.item.itemId);
  const answerable = answerableActivity(task, state);
  const word = status === 'empty' ? t('detail.stopped') : status === 'backoff' ? backoffLabel(backoffUntil(task, state), Date.now()) : statusText(status); // #805
  // Since the stop (#580): refreshed by each state broadcast, no timer of its own; a task stopped before stoppedAt existed reads as before
  const stoppedAt = live?.stoppedAt;
  const since = status === 'empty' && stoppedAt !== undefined ? [compact(Math.max(0, Date.now() - Date.parse(stoppedAt)))] : [];
  return (
    <section aria-label={word} className={`flex flex-col gap-2.5 rounded-lg border p-2.5 ${STATUS_BOX[status]}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`font-medium ${STATUS_WORD[status]}`}>{word}</span>
        <span className={`ml-auto ${MUTED}`}>{[t('detail.stage', { stage: task.stage }), ...since].join(' · ')}</span>
      </div>
      {isActivity && <RunLines task={task} state={state} />}
      <CommandsLine task={task} state={state} /> {/* #755: a commands stage's progress or failure, with ver saída */}
      {answerable && <ApprovalActions key={answerable.approval?.since} task={task} activity={answerable} openSession={openFeedbackSession(task, state) !== undefined} createsIssues={createsIssues(task, state)} />}
      <StoppedActions task={task} state={state} />
    </section>
  );
}

// A GitHub issue reads repo#n; any other URL its task id
function issueName(task: Task): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/.exec(task.item.url);
  return match ? `${match[1]}#${match[2]}` : task.item.id;
}

// The issue row's value: a link to the source's item. A local task has no row at all
function IssueValue({ task }: { task: Task }) {
  return <a href={task.item.url} target="_blank" rel="noreferrer" className="truncate">{issueName(task)}</a>;
}

// A PR's link (#207, #758): its page through the dock's opener, else GitHub, as any link opens
function PrLink({ url, className, children }: { url: string; className?: string; children: ReactNode }) {
  const openPr = useOpenPr();
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (openPr === undefined) return;
    event.preventDefault();
    openPr(url);
  };
  return <a href={url} target="_blank" rel="noreferrer" className={className} onClick={open}>{children}</a>;
}

/** What the panel's sections read of the State (#629): the workers, the activities they point at and the records. */
type Work = Pick<State, 'workers' | 'activities' | 'activityRecords'>;

// k/n, the number linking to the PR and its state (#698); then another repository's name, or on an open PR the PR it targets
function PrLineText({ line, repo }: { line: PrLine; repo?: string }) {
  const { pr, position, base } = line;
  const tail = repo ?? (pr.state === 'open' && base !== undefined ? t('prs.base', { n: prNumber(base) }) : undefined);
  return (
    <span className="truncate">
      {position && `${position.k}/${position.total} `}
      <PrLink url={pr.url}>{`#${prNumber(pr.url)}`}</PrLink>
      {` · ${t(`detail.pr.${pr.state}`)}${tail === undefined ? '' : ` · ${tail}`}`}
    </span>
  );
}

// One repository's PRs (#698): another repository's after a separator; a group with slices under its header
function PrGroupLines({ group }: { group: PrGroup }) {
  return (
    <>
      {!group.own && <hr className="my-1 border-t" />}
      {group.type !== undefined && <span className={MUTED}>{`${t(`prs.type.${group.type}`)} · ${t('prs.merged', { x: group.merged, y: group.slices })}`}</span>}
      {group.lines.map((line) => <PrLineText key={line.pr.url} line={line} repo={group.own ? undefined : repoName(group.repo)} />)}
    </>
  );
}

// Every PR the task's workers opened (#207), grouped by repository in merge order (#698), with the state the last poll read
function PrValue({ task, state }: { task: Task; state: Work }) {
  const groups = prGroups(prsOf(state, task.item.itemId), task.item.facets?.repository);
  if (groups.length === 0) return <span className={MUTED}>{t('detail.noPr')}</span>;
  return <div className="flex min-w-0 flex-col">{groups.map((group) => <PrGroupLines key={group.repo} group={group} />)}</div>;
}

// Every run on the task so far (#248): working time (the waiting left out) and tokens, the running sessions included
function totalText(task: Task, state: Work): string {
  const total = taskTotals(state, task, Date.now());
  return t('detail.total', { time: compact(total.ms - total.waitingMs), tokens: fmt(total.tokens) });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={MUTED}>{label}</dt>
      <dd className="flex min-w-0">{children}</dd>
    </>
  );
}

/** The metadata grid (redesign 06): who starts the task, its PRs, the issue, the branch and the totals; narrower labels under Atividades. */
export function MetaGrid({ task, state, isActivity }: { task: Task; state: Work; isActivity: boolean }) {
  const columns = isActivity ? 'grid-cols-[56px_minmax(0,1fr)]' : 'grid-cols-[72px_minmax(0,1fr)]';
  const sync = activityOf(state, task.item.itemId)?.sync;
  return (
    <dl className={`grid ${columns} gap-x-2 gap-y-1.5 text-xs`}>
      <Row label={t('detail.start')}>{task.auto ? t('detail.start.auto') : t('detail.start.byYou')}</Row>
      <Row label={t('detail.prs')}><PrValue task={task} state={state} /></Row>
      {!task.created && <Row label={t('detail.issue')}><IssueValue task={task} /></Row>}
      <Row label={t('detail.branch')}><span className="truncate font-mono">{activityOf(state, task.item.itemId)?.branch ?? '—'}</span></Row>
      {sync && <Row label={t('detail.base')}><span className="truncate font-mono">{baseText(sync)}</span></Row>}
      <Row label={t('detail.totalLabel')}>{totalText(task, state)}</Row>
    </dl>
  );
}

// The task's Claude sessions (#236), oldest first: the short id, the stages it ran in and when the Hive last put it to work. Each one a worker
// may resume gets abrir (#208), whose run attaches at once (#249), and limpar (#304), one click, no confirm; one a live run holds reads aberta.
export function SessionsList({ task, state, locale }: { task: Task; state: Work; locale: string }) {
  const openRun = useOpenRun();
  const sessions = sessionsOf(state, task.item.itemId);
  if (sessions.length === 0) return null;
  const offered = new Set(continuable(task, state).map((s) => s.id));
  // under the session's record, a deleted activity's too (#629)
  const route = (id: string, action: 'open' | 'clear'): string =>
    `${sessionPath({ activityId: recordWithSession(state, task.item.itemId, id)?.id ?? '', sessionId: id })}/${action}`;
  const open = (id: string): void => {
    act<OpenResult>(route(id, 'open'), { size: shownSize() }).then((result) => { if (result) attachRun(result, task, 'session', openRun); });
  };
  // '' = a task saved before the list had dates; a free session is named first, before any stage a feedback run gave it (#812)
  const history = (s: Session): string =>
    [s.free ? t('detail.freeSession') : '', s.stages.join(' → '), s.lastUsedAt === '' ? '' : clock(s.lastUsedAt, locale), s.repo ? t('detail.repoSession') : ''].filter(Boolean).join(' · ');
  return (
    <section aria-label={t('detail.sessions')} className="flex flex-col gap-1.5 text-xs">
      <h3 className={MUTED}>{t('detail.sessions')}</h3>
      <ul className="flex flex-col gap-1.5">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-baseline gap-2">
            <span className="font-mono">{s.id.slice(0, SESSION_ID_CHARS)}</span>
            <span className={`min-w-0 flex-1 truncate ${MUTED}`}>{history(s)}</span>
            {offered.has(s.id)
              ? (
                <>
                  <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={() => open(s.id)}>{t('detail.openSession')}</Button>
                  <Button type="button" variant="link" size="xs" className={`h-auto p-0 ${MUTED}`} onClick={() => void act(route(s.id, 'clear'))}>{t('detail.clearSession')}</Button>
                </>
              )
              : <span className={`whitespace-nowrap ${MUTED}`}>{t('detail.sessionHeld')}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const basename = (path: string): string => path.split('/').at(-1) ?? path;
const PREVIEW = { preview: true } as const;

/** What the task produced so far (redesign 06): the files of its result (#258), a markdown one opening rendered in the preview pane (#697),
 * any other in the editor pane. Its PRs stay in the PRs field, which carries their state, and are not repeated here (#809). Hidden
 * while it has no file. */
export function ResultsList({ task, files }: { task: Task; files: TaskFile[] }) {
  const openFile = useOpenFile();
  if (files.length === 0) return null;
  const open = (path: string): void => {
    // The dock refuses a deleted activity's file (the IDE is gone, #818): say so rather than do nothing
    if (openFile?.(task.item.itemId, path, undefined, isMarkdownPath(path) ? PREVIEW : undefined) === false) toast.error(t('detail.resultGone'));
  };
  const row = 'grid grid-cols-[56px_minmax(0,1fr)] gap-2';
  return (
    <section aria-label={t('detail.results')} className="flex flex-col gap-1.5 text-xs">
      <h3 className={MUTED}>{t('detail.results')}</h3>
      {files.map((f) => (
        <div key={f.key} className={row}>
          <span className={`truncate ${MUTED}`}>{f.key}</span>
          <Button
            type="button" variant="link" size="xs" title={f.path} className="h-auto min-w-0 justify-start p-0 font-mono text-review"
            onClick={() => open(f.path)}
          >
            <span className="truncate">{basename(f.path)}</span>
          </Button>
        </div>
      ))}
    </section>
  );
}
