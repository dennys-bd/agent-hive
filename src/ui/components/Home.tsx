import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { recordWithSession } from '../../activities';
import { taskLabel, resolveWorkspace, continuable, SESSION_ID_CHARS } from '../../tasks';
import type { Activity as LiveActivity, ActivityRecord, Task, Session, OpenResult, OperationId, State, Worker } from '../../types';
import { displayBinding } from '../../shortcuts';
import { act, attachRun } from '@/components/actions';
import { useOpenRun } from '@/components/terminal-tabs';
import { StatusWord } from '@/components/StatusWord';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { sessionPath } from '@/lib/copy-targets';
import { type PendingRow, pendingSessions, type RecentRow, recentActivities, relativeTime } from '@/lib/home';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { STATUS_BORDER } from '@/lib/status';
import { workspaceColor } from '@/lib/workspace-color';
import { shownSize } from '@/lib/xterm-setup';

/** What the home reaches beyond the State (redesign 08): the activity to open, whether a task is one now, and the quick actions. */
export interface HomeNav {
  openActivity(taskId: string): void; isLive(taskId: string): boolean;
  newActivity(): void; localTerminal(): void; addWorkspace?(): void;
}

/** What the home's rows read of the State (#629): the workers, the activities they point at and the records. */
type Work = Pick<State, 'workers' | 'activities' | 'activityRecords'>;

interface HomeProps { tasks: Task[]; workers: Worker[]; liveActivities: LiveActivity[]; activityRecords: ActivityRecord[]; workspaces: string[]; sourceWorkspaces?: Record<string, string>; nav: HomeNav }

const MUTED = 'text-muted-foreground text-xs';
const AGENT = 'claude'; // every worker run is Claude's today (#489): each runner's issue (#101, #102, #103) names its own
const HINTS: ReadonlyArray<[OperationId, MessageKey]> = [
  ['newActivity', 'home.newActivity'], ['search', 'home.search'], ['newTerminal', 'home.localTerminal'], ['viewFlow', 'home.flow'],
];

const keyOf = (id: OperationId): string | undefined => {
  const current = binding(id);
  return current === null ? undefined : displayBinding(current, isMac());
};

// The task's workspace colour, or none when it resolves to no workspace
export function Square({ task, workspaces, sourceWorkspaces }: { task: Task; workspaces: string[]; sourceWorkspaces?: Record<string, string> }) {
  const workspace = resolveWorkspace(task, workspaces, sourceWorkspaces);
  const style = workspace === undefined ? undefined : { background: workspaceColor(workspace) };
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px] bg-muted" style={style} />;
}

function Header({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-lg leading-none">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{text}</p>
      </div>
      <div className="flex gap-2">{children}</div>
    </>
  );
}

type RowProps = Omit<HomeProps, 'tasks' | 'workers' | 'liveActivities' | 'activityRecords'>;

// A session that needs the user: abrir while it waits on them, revisar while its stage awaits approval; both open its activity
function PendingItem({ row, workspaces, sourceWorkspaces, nav }: RowProps & { row: PendingRow }) {
  const id = row.worker.sessionId?.slice(0, SESSION_ID_CHARS);
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-[13px] ${STATUS_BORDER[row.status]}`}>
      <Square task={row.task} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces} />
      <span className="min-w-0 flex-1 truncate">{taskLabel(row.task)}</span>
      {id !== undefined && <span className={MUTED}>{t('home.session', { agent: AGENT, id })}</span>}
      <StatusWord status={row.status} />
      <Button type="button" size="xs" variant="outline" onClick={() => nav.openActivity(row.task.item.itemId)}>
        {t(row.status === 'waiting' ? 'home.open' : 'home.review')}
      </Button>
    </div>
  );
}

// The session a recent task resumes: the one the Hive used last among those a worker may resume
const lastContinuable = (task: Task, state: Work): Session | undefined => continuable(task, state).reduce<Session | undefined>(
  (last, s) => (last === undefined || s.lastUsedAt > last.lastUsedAt ? s : last), undefined);

// A recent task: its activity while it runs, else its last session resumed, whose run then opens as the activity (#249)
function RecentItem({ row, state, workspaces, sourceWorkspaces, nav }: RowProps & { row: RecentRow; state: Work }) {
  const openRun = useOpenRun();
  const { task } = row;
  const itemId = task.item.itemId;
  const isLive = nav.isLive(itemId);
  const session = isLive ? undefined : lastContinuable(task, state);
  const resume = (id: string): void => {
    const record = recordWithSession(state, itemId, id); // the session's record, a deleted activity's too (#629)
    if (!record) return;
    void act<OpenResult>(`${sessionPath({ activityId: record.id, sessionId: id })}/open`, { size: shownSize() }).then((result) => { if (result) attachRun(result, task, 'session', openRun); });
  };
  const onClick = (): void => (session === undefined ? nav.openActivity(itemId) : resume(session.id));
  return (
    <button
      type="button" disabled={!isLive && session === undefined} onClick={onClick}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-[7px] text-left text-[13px] hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <Square task={task} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces} />
      <span className="min-w-0 flex-1 truncate">{taskLabel(task)}</span>
      <StatusWord status={row.status} />
      <span className={`w-16 shrink-0 text-right ${MUTED}`}>{relativeTime(row.lastUsedAt)}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[4px] border px-1.5 py-px font-sans text-foreground tracking-widest">{children}</kbd>;
}

function Hints() {
  const hints = HINTS.flatMap(([id, label]) => {
    const key = keyOf(id);
    return key === undefined ? [] : [{ id, key, label }];
  });
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 border-t pt-2 text-muted-foreground text-xs">
      {hints.map(({ id, key, label }) => <span key={id} className="flex items-center gap-2"><Kbd>{key}</Kbd>{t(label)}</span>)}
    </div>
  );
}

function Actions({ nav }: { nav: HomeNav }) {
  const newKey = keyOf('newActivity');
  return (
    <>
      <Button type="button" size="sm" onClick={nav.newActivity}>
        {t('home.newActivity')}
        {newKey && <span className="font-normal tracking-widest opacity-60">{newKey}</span>}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={nav.localTerminal}>
        {t('home.localTerminal')}
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
    </>
  );
}

/** The center under Atividades with no activity open (redesign 08, after #458): how to start, the sessions that need the user, the tasks
 * worked on last and the keys. With no workspace yet, only how to add one. */
export function Home({ tasks, workers, liveActivities, activityRecords, ...rest }: HomeProps) {
  const work: Work = { workers, activities: liveActivities, activityRecords };
  const { workspaces, nav } = rest;
  const pending = pendingSessions({ tasks, ...work });
  const recent = recentActivities({ tasks, ...work });
  const isFirstRun = workspaces.length === 0;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 justify-center overflow-y-auto px-12 py-[72px]">
      <div className="flex w-full max-w-[620px] flex-col gap-8">
        {isFirstRun
          ? (
            <Header title={t('home.noWorkspace.title')} text={t('home.noWorkspace.text')}>
              <Button type="button" size="sm" onClick={nav.addWorkspace}>{t('home.noWorkspace.add')}</Button>
            </Header>
          )
          : <Header title={t('home.title')} text={t('home.subtitle')}><Actions nav={nav} /></Header>}
        {pending.length > 0 && (
          <section aria-label={t('home.pending', { n: pending.length })} className="flex flex-col gap-2">
            <h3 className={MUTED}>{t('home.pending', { n: pending.length })}</h3>
            {pending.map((row) => <PendingItem key={row.worker.id} row={row} {...rest} />)}
          </section>
        )}
        {recent.length > 0 && (
          <section aria-label={t('home.recent')} className="flex flex-col gap-0.5">
            <h3 className={`pb-1.5 ${MUTED}`}>{t('home.recent')}</h3>
            {recent.map((row) => <RecentItem key={row.task.item.itemId} row={row} state={work} {...rest} />)}
          </section>
        )}
        {!isFirstRun && <Hints />}
      </div>
    </section>
  );
}
