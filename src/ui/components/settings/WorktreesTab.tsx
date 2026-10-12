import { XIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Confirm } from '@/components/Confirm';
import { taskError } from '@/components/CommandsProgress';
import { activityDeletionUrl, type Removal, DeleteActivity } from '@/components/DeleteActivity';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { statusText, t, tPlural } from '@/i18n';
import { getJson, postJson } from '@/lib/api';
import { taskState } from '@/lib/task-state';
import { taskId, isLive } from '../../../tasks';
import type { State, WorktreeRow } from '../../../types';

type Slice = Pick<State, 'tasks' | 'workers' | 'terminals' | 'activities' | 'activityRecords'>;
type Filter = 'all' | 'orphans';

interface Outcome { removed: string[]; refused: { slug: string; reason: string }[] }

/** Where a row's removal goes: the task's own route (#182) for a task's worktree, the workspace + slug route (#181, #179) for one no task owns. */
const removalUrl = (row: WorktreeRow): string =>
  row.task ? activityDeletionUrl(row.task.activityId) : `/worktrees/${encodeURIComponent(row.workspace)}/${encodeURIComponent(row.slug)}/remove`;

/** What `apagar todos` posts: every noTask or kept row, and a deleteActivityFailed row whose task allows the removal (canDeleteActivity). */
const isCleanable = (row: WorktreeRow): boolean => row.orphan === 'noTask' || row.orphan === 'kept' || (row.orphan === 'deleteActivityFailed' && row.task?.removable === true);

const workspacesOf = (rows: WorktreeRow[]): string[] => [...new Set(rows.map((r) => r.workspace))]; // #179: in the order the server lists them

// One after another and never forced (a bulk force is never one click): git's refusal, or a route's error, is kept with the slug and
// the row stays in the list to be forced by hand.
async function cleanAll(rows: WorktreeRow[]): Promise<Outcome> {
  let outcome: Outcome = { removed: [], refused: [] };
  for (const row of rows) {
    const answer = await postJson<Removal>(removalUrl(row)).catch((err: Error): Removal => ({ removed: false, refused: err.message }));
    outcome = answer.removed
      ? { ...outcome, removed: [...outcome.removed, row.slug] }
      : { ...outcome, refused: [...outcome.refused, { slug: row.slug, reason: answer.refused }] };
  }
  return outcome;
}

/** The confirm text, prefixed with what is being removed: its branch, its owning task (or the lack of either), and the delete activity error if any. */
const removalMessage = (row: WorktreeRow): string => {
  const { task } = row;
  const lines = [
    t('worktrees.branch', { branch: row.branch ?? t('worktrees.detached') }),
    t('worktrees.task', { title: task ? task.title : t('worktrees.noTask') }),
    ...(task?.error ? [taskError(task.error)] : []), // #945: a failed start's short message, never its path
    '',
    t(task ? 'confirm.deleteActivity' : 'confirm.removeOrphanWorktree'),
  ];
  return lines.join('\n');
};

const ROW = 'grid grid-cols-[6rem_minmax(0,1fr)_16rem_2.5rem] items-center gap-3 border-b border-l-2 px-5 py-2.5 last:border-b-0';

// The red dot and word of a row nothing in the flow keeps: an orphan, or a task whose delete activity failed (its error on hover).
function OrphanStatus({ label, title }: { label: string; title?: string }) {
  return (
    <span title={title} className="flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />{label}
    </span>
  );
}

// An active row's stage, its most urgent run and an open session, read from the State the page already holds; nothing when it has none yet.
function RowStatus({ row, state }: { row: WorktreeRow; state?: Slice }) {
  if (row.orphan === 'kept') return <OrphanStatus label={t('worktrees.kept')} />; // #861
  if (row.orphan === 'noTask') return <OrphanStatus label={t('worktrees.orphan')} />;
  if (row.orphan === 'deleteActivityFailed') return <OrphanStatus label={t('worktrees.deleteActivityFailed')} title={row.task?.error === undefined ? undefined : taskError(row.task.error)} />;
  const task = state?.tasks.find((c) => taskId(c) === row.task?.id);
  if (!state || !task) return <span />;
  const status = taskState(task, state); // the task's state, as every other surface shows it (#663)
  const parts = [task.stage, status === 'empty' ? t('worktrees.stopped') : statusText(status), ...(isLive(task, state) ? [t('worktrees.sessionOpen')] : [])];
  return <span className="text-muted-foreground text-xs">{parts.join(' · ')}</span>;
}

// A task that may not lose its worktree now keeps a disabled × with the reason on hover, instead of no × at all.
function RemoveButton({ row, onDone }: { row: WorktreeRow; onDone(): void }) {
  const trigger = <Button type="button" variant="ghost" size="icon-sm" aria-label={t('worktrees.remove')}><XIcon /></Button>;
  if (row.task && !row.task.removable) {
    return <span title={t('worktrees.sessionBlocks')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('worktrees.remove')} disabled><XIcon /></Button></span>;
  }
  return <DeleteActivity url={removalUrl(row)} message={removalMessage(row)} available onDone={onDone} trigger={trigger} />;
}

function WorktreeItem({ row, state, onDone }: { row: WorktreeRow; state?: Slice; onDone(): void }) {
  const { task } = row;
  // an orphan shows what git lists there: its branch, or its folder when detached
  const title = task ? task.title : (row.branch ?? row.slug);
  return (
    <li className={`${ROW} ${row.orphan ? 'border-l-destructive' : 'border-l-transparent'}`}>
      <span className="truncate text-muted-foreground text-xs">{task?.id ?? '—'}</span>
      {/* capped so a long title leaves the status and the × where they are; the full text stays on hover (#322) */}
      <span className={`min-w-0 truncate text-sm ${task ? 'font-medium' : 'font-mono'}`} title={title}>{title}</span>
      <RowStatus row={row} state={state} />
      <RemoveButton row={row} onDone={onDone} />
    </li>
  );
}

function WorkspaceRows({ workspace, all, rows, state, onDone }: { workspace: string; all: WorktreeRow[]; rows: WorktreeRow[]; state?: Slice; onDone(): void }) {
  const orphans = all.filter((r) => r.orphan !== undefined).length;
  return (
    <section aria-label={workspace}>
      <div className="flex items-baseline gap-2 border-b bg-muted/40 px-5 py-2">
        <span className="font-medium text-xs">{workspace}</span>
        <span className="text-muted-foreground text-xs">
          {`${tPlural('worktrees.count', all.length, { n: all.length })} · ${tPlural('worktrees.orphanCount', orphans, { n: orphans })}`}
        </span>
      </div>
      <ul>{rows.map((row) => <WorktreeItem key={row.slug} row={row} state={state} onDone={onDone} />)}</ul>
    </section>
  );
}

function FilterToggle({ value, all, orphans, onChange }: { value: Filter; all: number; orphans: number; onChange(filter: Filter): void }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => { if (v) onChange(v as Filter); }}>
      <ToggleGroupItem value="all">{t('worktrees.filter.all', { n: all })}</ToggleGroupItem>
      <ToggleGroupItem value="orphans">{t('worktrees.filter.orphans', { n: orphans })}</ToggleGroupItem>
    </ToggleGroup>
  );
}

function useWorktrees() {
  const [rows, setRows] = useState<WorktreeRow[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setRows(await getJson<WorktreeRow[]>('/worktrees'));
      setError(undefined);
    } catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { rows, error, load };
}

/** Settings › manutenção (#181, #513): every worktree git lists under each workspace's .hive/worktrees, the orphans marked, or only the
 * orphans. Bulk removal only takes orphans, as the per-row routes one after another, each validated by the server, so no bulk route exists;
 * an active worktree goes one at a time, through its task's route. */
export function WorktreesTab({ state }: { state?: Slice }) {
  const { rows, error, load } = useWorktrees();
  const [filter, setFilter] = useState<Filter>('all');
  const [outcome, setOutcome] = useState<Outcome>();
  const all = rows ?? [];
  const orphans = all.filter((r) => r.orphan !== undefined);
  const shown = filter === 'all' ? all : orphans;
  const cleanable = orphans.filter(isCleanable);
  const reload = (): void => { setOutcome(undefined); void load(); };
  const clean = async (): Promise<void> => {
    setOutcome(await cleanAll(cleanable));
    await load();
  };
  const actions = (
    <>
      <FilterToggle value={filter} all={all.length} orphans={orphans.length} onChange={setFilter} />
      <Confirm
        message={t('confirm.cleanOrphans', { n: cleanable.length })}
        confirmLabel={t('worktrees.cleanOrphans')}
        trigger={<Button type="button" variant="destructive" size="sm" disabled={cleanable.length === 0}>{t('worktrees.cleanOrphans')}</Button>}
        onConfirm={() => void clean()}
      />
    </>
  );
  return (
    <SettingsGroup title="settings.group.orphans" hint="worktrees.hint" flush action={actions}>
      {error && <p className="whitespace-pre-wrap px-5 py-3 text-destructive text-sm">{error}</p>}
      {rows && shown.length === 0 && <p className="px-5 py-3 text-muted-foreground text-xs">{t(filter === 'all' ? 'worktrees.none' : 'worktrees.empty')}</p>}
      {workspacesOf(shown).map((workspace) => (
        <WorkspaceRows
          key={workspace} workspace={workspace} all={all.filter((r) => r.workspace === workspace)} rows={shown.filter((r) => r.workspace === workspace)}
          state={state} onDone={reload}
        />
      ))}
      {outcome && (
        <div role="status" className="flex flex-col gap-1 border-t px-5 py-3 text-xs">
          {outcome.removed.length > 0 && <p>{t('worktrees.removed', { slugs: outcome.removed.join(', ') })}</p>}
          {outcome.refused.map(({ slug, reason }) => <p key={slug} className="whitespace-pre-wrap text-destructive">{t('worktrees.refused', { slug, reason })}</p>)}
        </div>
      )}
      {rows && <p className="border-t px-5 py-4 text-muted-foreground text-xs">{t('worktrees.footer')}</p>}
    </SettingsGroup>
  );
}
