import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { activityOf, localActivityId } from '../../activities.js';
import { taskLabel } from '../../tasks.js';
import { hasDirectory } from '../../local-sessions.js';
import type { Activity, Task, SessionRef, SessionTarget, State } from '../../types.js';
import { CopySessionDialog } from '@/components/CopySessionDialog';
import type { MenuKit } from '@/components/menu-kit';
import { useBranches } from '@/components/QuickDialogs';
import { StartDialog } from '@/components/StartDialog';
import { useOpenStarted } from '@/components/terminal-tabs';
import { t } from '@/i18n';
import { type CopySource, copyRefusal, copyTargets, sessionRefOf, workspaceOf } from '@/lib/copy-targets';

export interface CopyHost { state: State; begin(from: SessionRef, to: SessionTarget | 'newActivity'): void }

const CopyHostContext = createContext<CopyHost | undefined>(undefined);

/** The copy's host (#587), or undefined outside one (a component test, the terminal's harness): a menu without it offers no copy. */
export const useCopyHost = (): CopyHost | undefined => useContext(CopyHostContext);

interface Pending { from: SessionRef; to: SessionTarget }
interface AwaitedActivity { from: SessionRef; taskId: string }

/** How long nova atividade… waits for the new activity's directory: a worktree setup (#351) may run a while, a start that never gets one must
 * not open a copy dialog out of nowhere much later. */
export const AWAIT_DIRECTORY_MS = 5 * 60_000;

// An activity that will not get its directory from this start: its spawn failed, it left the flow, or an archive or removal is on it
const gaveUp = (task: Task, activity: Activity | undefined): boolean => activity?.error !== undefined || task.missing === true || task.leaving === true;

/** The new activity of nova atividade… (Planning default 5): the copy waits for its directory, and refuses at once what the UI narrows out.
 * `cancel`: the user opened another copy or Start dialog, which replaces this one. */
export function useAwaitedActivity(state: State, onReady: (pending: Pending) => void): { await(next: AwaitedActivity): void; cancel(): void } {
  const [awaiting, setAwaiting] = useState<AwaitedActivity>();
  useEffect(() => {
    if (awaiting === undefined) return;
    const timer = setTimeout(() => setAwaiting(undefined), AWAIT_DIRECTORY_MS);
    return () => clearTimeout(timer);
  }, [awaiting]);
  useEffect(() => {
    if (awaiting === undefined) return;
    const task = state.tasks.find((c) => c.item.itemId === awaiting.taskId);
    if (task === undefined) return; // the task was created a moment ago: the state has not reached us yet
    const refusal = copyRefusal(state, awaiting.from, awaiting.taskId);
    if (refusal !== undefined) toast.error(t(refusal));
    else if (!gaveUp(task, activityOf(state, task.item.itemId))) { // one that gave up shows why on its own task: the wait just ends
      const live = activityOf(state, task.item.itemId);
      if (!live || !hasDirectory(live)) return;
      onReady({ from: awaiting.from, to: { activityId: live.id } }); // the new task's live activity (#629)
    }
    setAwaiting(undefined);
  }, [awaiting, state, onReady]);
  return useMemo(() => ({ await: setAwaiting, cancel: () => setAwaiting(undefined) }), []);
}

/** The copy's dialogs (#587), inside MainDock's openers so they reach the run opener: the copy dialog, and for nova atividade… the Start
 * dialog, then the wait for the new activity's directory. `shown`: the activity the center shows, where a copy opens as a tab (A5). */
export function CopySessionHost({ state, shown, children }: { state: State; shown?: string; children: ReactNode }) {
  const openStarted = useOpenStarted();
  const [copy, setCopy] = useState<Pending>();
  const [starting, setStarting] = useState<{ from: SessionRef; workspace?: string }>();
  const awaited = useAwaitedActivity(state, setCopy);
  const begin = useCallback((from: SessionRef, to: SessionTarget | 'newActivity'): void => {
    awaited.cancel();
    if (to === 'newActivity') setStarting({ from, workspace: workspaceOf(state, from) });
    else setCopy({ from, to });
  }, [state, awaited]);
  const host = useMemo(() => ({ state, begin }), [state, begin]);
  return (
    <CopyHostContext.Provider value={host}>
      {children}
      {starting && (
        <StartDialog
          state={state} workspace={starting.workspace} onStarted={openStarted}
          onActivity={(taskId) => awaited.await({ from: starting.from, taskId })} onClose={() => setStarting(undefined)}
        />
      )}
      {copy && <CopySessionDialog state={state} from={copy.from} to={copy.to} shown={shown} onClose={() => setCopy(undefined)} />}
    </CopyHostContext.Provider>
  );
}

const BRANCH = 'font-mono text-muted-foreground text-xs';

// Mounted on open, so the checkouts' branches are read only then
function Destinations({ from, workspace, local, activities, kit, host }: { from: SessionRef; workspace: string; local: boolean; activities: Task[]; kit: MenuKit; host: CopyHost }) {
  const branches = useBranches(true, workspace);
  const { Item, Separator } = kit;
  return (
    <>
      <div className="px-2 py-1 text-muted-foreground text-xs">{workspace}</div>
      {local && (
        <Item className="flex-col items-start gap-0.5" onSelect={() => host.begin(from, { activityId: localActivityId(workspace) })}>
          <span>{t('activities.local')}</span>
          {branches[workspace] && <span className={BRANCH}>{branches[workspace]}</span>}
        </Item>
      )}
      {activities.map((task) => {
        const live = activityOf(host.state, task.item.itemId); // copyTargets offers only tasks with a live directory (#629)
        const branch = live?.branch;
        return (
          <Item key={task.item.itemId} className="flex-col items-start gap-0.5" onSelect={() => live && host.begin(from, { activityId: live.id })}>
            <span>{taskLabel(task)}</span>
            {branch && <span className={BRANCH}>{branch}</span>}
          </Item>
        );
      })}
      <Separator />
      <Item onSelect={() => host.begin(from, 'newActivity')}>{t('activities.new')}</Item>
    </>
  );
}

/** copiar para… › (#587, 6a): the source's workspace, its local with the branch, its other activities with their branch, nova atividade….
 * Nothing outside a host (a component test, the terminal's harness). `separated` puts a separator before it. */
export function CopyToSub({ source, kit, separated }: { source: CopySource; kit: MenuKit; separated?: boolean }) {
  const host = useCopyHost();
  if (host === undefined) return null;
  const from = sessionRefOf(host.state, source);
  const targets = from && copyTargets(host.state, from);
  const { Separator, Sub, SubTrigger, SubContent } = kit;
  return (
    <>
      {separated && <Separator />}
      <Sub>
        <SubTrigger disabled={targets?.workspace === undefined}>{t('copy.to')}</SubTrigger>
        {from && targets?.workspace !== undefined && (
          <SubContent className="w-[250px]">
            <Destinations from={from} workspace={targets.workspace} local={targets.local} activities={targets.activities} kit={kit} host={host} />
          </SubContent>
        )}
      </Sub>
    </>
  );
}
