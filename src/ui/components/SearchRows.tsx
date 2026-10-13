import { CheckIcon } from 'lucide-react';
import { taskLabel, isBlocked } from '../../tasks';
import type { Task, State } from '../../types';
import { taskAutoBadge } from '@/lib/auto-badge';
import { Square } from '@/components/Home';
import { GitMarkLetter } from '@/components/GitMarkLetter';
import { KeyHint } from '@/components/KeyHint';
import { agentName } from '../../agents';
import { StatusWord } from '@/components/StatusWord';
import { CommandItem } from '@/components/ui/command';
import { t } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { relativeTime } from '@/lib/home';
import type { Range, SearchRow } from '@/lib/search';

/** A row's box (the handoff): 7px 10px, radius-md, 13px; the selected one on muted. */
export const ROW = 'gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] data-[selected=true]:bg-muted';
const META = 'shrink-0 whitespace-nowrap text-muted-foreground text-xs';

interface Part { at: number; text: string; isHit: boolean }

// The text cut at the ranges, in order, each part keyed by where it starts
function partsOf(text: string, ranges: readonly Range[]): Part[] {
  const cuts = ranges.flatMap(([start, end], i): Part[] => {
    const from = i === 0 ? 0 : ranges[i - 1][1];
    return [{ at: from, text: text.slice(from, start), isHit: false }, { at: start, text: text.slice(start, end), isHit: true }];
  });
  const from = ranges.at(-1)?.[1] ?? 0;
  return [...cuts, { at: from, text: text.slice(from), isHit: false }].filter((part) => part.text !== '');
}

/** The text with its matched parts in foreground 500 (the handoff). */
export function Highlight({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  return (
    <span className="min-w-0 truncate">
      {partsOf(text, ranges).map((part) => (part.isHit ? <b key={part.at} className="font-medium text-foreground">{part.text}</b> : <span key={part.at}>{part.text}</span>))}
    </span>
  );
}

function Title({ text, ranges, meta }: { text: string; ranges: readonly Range[]; meta?: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <Highlight text={text} ranges={ranges} />
      {meta && <span className={META}>{meta}</span>}
    </span>
  );
}

// The ranges that fall in [from, to), counted from `from`: a path's match cut at its file name (#133)
const clip = (ranges: readonly Range[], from: number, to: number): Range[] =>
  ranges.flatMap(([start, end]): Range[] => (end <= from || start >= to ? [] : [[Math.max(start, from) - from, Math.min(end, to) - from]]));

// ·, the path in mono, its folders muted and its name in foreground, the match in 500; the git mark on the right as the tree draws it (#133)
function FileBody({ row }: { row: Extract<SearchRow, { kind: 'file' }> }) {
  const cut = row.path.lastIndexOf('/') + 1;
  return (
    <>
      <span aria-hidden="true" className="w-3.5 shrink-0 text-center text-muted-foreground">·</span>
      <span className="flex min-w-0 flex-1 font-mono">
        <span className="min-w-0 truncate text-muted-foreground"><Highlight text={row.path.slice(0, cut)} ranges={clip(row.ranges, 0, cut)} /></span>
        <span className="shrink-0 text-foreground"><Highlight text={row.path.slice(cut)} ranges={clip(row.ranges, cut, row.path.length)} /></span>
      </span>
      {row.mark && <GitMarkLetter mark={row.mark} />}
    </>
  );
}

// title · the agent and how long ago it last worked, then its main session's status (the handoff); a terminals-only one has none
function ActivityBody({ activity, ranges, state }: { activity: TaskActivity; ranges: readonly Range[]; state: State }) {
  const { task } = activity;
  const sessions = activity.records.flatMap((r) => r.sessions);
  const latest = sessions.filter((s) => s.lastUsedAt !== '').sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt)).at(-1);
  const last = latest?.lastUsedAt ?? activity.startedAt;
  // #925: the agent of its live run, else of the session it used last; a terminals-only activity names none
  const agent = activity.runs.find((run) => run.agent !== undefined)?.agent ?? latest?.agent;
  const meta = [...(agent === undefined ? [] : [agentName(agent)]), ...(last === undefined ? [] : [relativeTime(last)])].join(' · ');
  return (
    <>
      <Square task={task} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} />
      <Title text={taskLabel(task)} ranges={ranges} meta={meta} />
      {activity.status !== 'empty' && <StatusWord status={activity.status} />}
    </>
  );
}

// title · stage, then its blocker or the auto badge (the handoff), as the task's face says them (#542)
function TaskBody({ task, ranges, state }: { task: Task; ranges: readonly Range[]; state: State }) {
  const isHeld = isBlocked(task.item);
  return (
    <>
      <Square task={task} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} />
      <Title text={taskLabel(task)} ranges={ranges} meta={task.stage} />
      {isHeld && <span className={META}>{t('task.blockedBy', { ids: (task.item.blockedBy ?? []).join(', ') })}</span>}
      {!isHeld && task.auto && <span className={`shrink-0 rounded-sm border px-1 font-medium text-muted-foreground text-xs ${taskAutoBadge(task, state)}`}>{t('flow.auto')}</span>}
    </>
  );
}

// ›, the label · its target, a check while on, and the shortcut when it has one: the keys shown teach them (the spec)
function OperationBody({ row }: { row: Extract<SearchRow, { kind: 'operation' }> }) {
  const { view } = row;
  return (
    <>
      <span aria-hidden="true" className="w-3.5 shrink-0 text-center text-muted-foreground">›</span>
      <Title text={view.label} ranges={row.ranges} meta={view.target} />
      {view.isChecked && <CheckIcon aria-hidden="true" className="size-4" />}
      {view.operation.shortcut && <KeyHint id={view.operation.shortcut} />}
    </>
  );
}

interface SearchRowItemProps { row: SearchRow; value: string; state: State; onSelect(): void }

/** One result as cmdk's item: ↵ or a click is onSelect; a disabled operation stays listed, inert. */
export function SearchRowItem({ row, value, state, onSelect }: SearchRowItemProps) {
  return (
    <CommandItem value={value} disabled={row.kind === 'operation' && row.view.isDisabled} onSelect={onSelect} className={ROW}>
      {row.kind === 'activity' && <ActivityBody activity={row.activity} ranges={row.ranges} state={state} />}
      {row.kind === 'task' && <TaskBody task={row.task} ranges={row.ranges} state={state} />}
      {row.kind === 'operation' && <OperationBody row={row} />}
      {row.kind === 'file' && <FileBody row={row} />}
    </CommandItem>
  );
}
