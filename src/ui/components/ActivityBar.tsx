import { Fragment, type ReactNode } from 'react';
import { taskTotals } from '../../record-kit';
import { taskLabel } from '../../tasks';
import type { State } from '../../types';
import { ActivityMenuButton } from '@/components/ActivityMenu';
import { LocalMenuButton } from '@/components/LocalMenu';
import { useBranches } from '@/components/QuickDialogs';
import { RunCommands } from '@/components/RunCommands';
import { SleepButton } from '@/components/SleepButton';
import { t } from '@/i18n';
import type { Activity, LocalActivity, TaskActivity } from '@/lib/activities';
import { compact, fmt } from '@/lib/usage';

interface ActivityBarProps { activity: Activity; state: State; focusedRun?: string; onShowFlow(): void }
interface Fact { key: string; node: ReactNode }

const BAR = 'flex min-w-0 flex-1 items-center gap-2.5 px-3';
const LINES = 'flex min-w-0 flex-1 flex-col';
const TITLE = 'min-w-0 truncate font-semibold text-[13px] leading-4';
const FACTS = 'min-w-0 truncate text-muted-foreground text-xs leading-4';
// The header drags the window (#221): the actions opt out to keep their clicks; the title and the facts drag with the empty space
const ACTIONS = 'flex shrink-0 items-center gap-2.5 [-webkit-app-region:no-drag]';

// Two lines, the title over the facts, then the actions on the right: the window header's center (#221, handoff §1)
function BarLines({ title, facts, children }: { title: ReactNode; facts: ReactNode; children: ReactNode }) {
  return (
    <div data-activity-bar className={BAR}>
      <div className={LINES}>
        <span className={TITLE}>{title}</span>
        <span className={FACTS}>{facts}</span>
      </div>
      <div className={ACTIONS}>{children}</div>
    </div>
  );
}

// The facts line: the stage, the branch in mono once a SessionStart reported it, and the task's totals as Detalhes reads them (#248), so
// both agree. A part with no value is left out, and its separator with it
function factsOf({ task, activity }: TaskActivity, state: Pick<State, 'workers' | 'activities' | 'activityRecords'>): Fact[] {
  const total = taskTotals(state, task, Date.now());
  const own = activity.branch; // the live activity's (#629)
  const branch: Fact[] = own === undefined ? [] : [{ key: 'branch', node: <span className="font-mono">{own}</span> }];
  return [
    { key: 'stage', node: t('detail.stage', { stage: task.stage }) },
    ...branch,
    { key: 'time', node: compact(total.ms - total.waitingMs) },
    { key: 'tokens', node: t('activity.bar.tokens', { tokens: fmt(total.tokens) }) },
  ];
}

// A local activity's bar (#590): local, then its workspace and the branch its checkout has out, in mono once read; dormir and the local
// menu's ⋯. No stage, no totals and no commands: the workspace's commands are not offered here yet
function LocalBar({ activity, focusedRun }: { activity: LocalActivity; focusedRun?: string }) {
  const branch = useBranches(true, activity.workspace)[activity.workspace];
  const facts = <>{activity.workspace}{branch && <>{' · '}<span className="font-mono">{branch}</span></>}</>;
  return (
    <BarLines title={t('activities.local')} facts={facts}>
      <SleepButton activity={activity} focusedRun={focusedRun} />
      <LocalMenuButton activity={activity} />
    </BarLines>
  );
}

/** The activity's title bar (redesign 04, #536), the window header's center since #221, in place of the old detail panel's row of buttons: the title and the facts,
 * then the workspace's commands (#300), dormir and the ⋯ with the activity's right-click items; a local activity's its own (#590). The title
 * is no heading: Detalhes holds the task's. */
export function ActivityBar({ activity, state, focusedRun, onShowFlow }: ActivityBarProps) {
  if (activity.kind === 'local') return <LocalBar activity={activity} focusedRun={focusedRun} />;
  const { task } = activity;
  const facts = factsOf(activity, state).map((fact, i) => <Fragment key={fact.key}>{i > 0 && ' · '}{fact.node}</Fragment>);
  return (
    <BarLines title={taskLabel(task)} facts={facts}>
      <RunCommands task={task} state={state} />
      <SleepButton activity={activity} focusedRun={focusedRun} />
      <ActivityMenuButton task={task} state={state} onShowFlow={onShowFlow} />
    </BarLines>
  );
}
