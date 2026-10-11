import { SearchIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { repoName } from '../../pull-requests';
import { resolveWorkspace } from '../../tasks';
import type { RepoSummary, SourceSync, Task, State } from '../../types';
import { act } from '@/components/actions';
import { ButtonKeyHint, KeyHint } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { onShortcutKey } from '@/lib/dock-layout';
import { workspaceColor } from '@/lib/workspace-color';

const pad = (n: number): string => String(n).padStart(2, '0');
// The loops toggle's two looks (#909): the dark twins beat the outline variant's dark:bg-input/30, which would otherwise paint both alike
const LOOPS_ON = 'bg-muted text-foreground dark:bg-muted';
const LOOPS_OFF = 'bg-transparent text-muted-foreground dark:bg-transparent';

/** The latest poll among the shown sources (#542): the picked one, or every one; local 24h HH:MM, undefined while none has polled. */
export function lastPolled(syncs: Record<string, SourceSync>, source?: string): string | undefined {
  const times = Object.entries(syncs).flatMap(([name, status]) => ((source === undefined || name === source) && status.polledAt ? [status.polledAt] : []));
  const latest = times.sort().at(-1); // ISO strings sort as the instants they name
  if (latest === undefined) return undefined;
  const time = new Date(latest);
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

// The workspaces the shown tasks resolve to, in the Comb's order: a legend of the colours the tasks carry, never a filter (the source is the
// flow's only one)
function shownWorkspaces(tasks: Task[], state: Pick<State, 'workspaces' | 'sourceWorkspaces' | 'tasks'>): string[] {
  const used = new Set(tasks.map((c) => resolveWorkspace(c, state.workspaces, state.sourceWorkspaces, state.tasks)));
  return state.workspaces.filter((name) => used.has(name));
}

// buscar tarefas (#542), or the repository's search (#757): the searchTasks key focuses it; the header stays mounted under Atividades (#596), so the key is bound only while the flow shows. Esc clears
// it and leaves, and its preventDefault keeps the detail panel's own Escape (#426) from closing the panel too. 200px in a source's or a repository's header (#756)
function SearchField({ label, value, isShown, isNarrow, onChange }: { label: string; value: string; isShown: boolean; isNarrow: boolean; onChange(term: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => (isShown ? onShortcutKey([[true, 'searchTasks']], () => input.current?.focus()) : undefined), [isShown]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onChange('');
    event.currentTarget.blur();
  };
  return (
    <label className={`flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 ${isNarrow ? 'min-w-[120px] flex-[0_1_200px]' : 'w-[240px]'}`}>
      <SearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <input
        ref={input} aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      />
      <KeyHint id="searchTasks" />
    </label>
  );
}

/** The tab the source header shows (#756): the flow, or the source's native view. */
export type SourceTab = 'flow' | 'native';
/** The source header's tabs (#756), offered while the pick is an external source; `label` names its native view by the source's type. */
export interface SourceTabs { label: string; active: SourceTab; onPick(tab: SourceTab): void }

// The source header (handoff 01): the source's name in place of fluxo, a divider, then fluxo and the native view as tabs
function SourceTitle({ name, tabs }: { name: string; tabs: SourceTabs }) {
  const tab = (id: SourceTab, label: string) => (
    <button
      key={id} type="button" role="tab" aria-selected={tabs.active === id} onClick={() => tabs.onPick(id)}
      className={`h-10 border-b-2 px-2 font-medium text-[13px] ${tabs.active === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </button>
  );
  return (
    <>
      <span className="font-semibold text-[13px] text-foreground">{name}</span>
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
      <div role="tablist" className="flex gap-0.5 self-stretch">{tab('flow', t('flow.tab.flow'))}{tab('native', tabs.label)}</div>
    </>
  );
}

/** A repository header's tab (#758): its PR list, or its issues. */
export type RepoTab = 'prs' | 'issues';
/** The repository header (#757, #758): the repository it shows, the tab shown, and what a tab's click does (its list, from a page too). */
export interface RepoHeader { summary: RepoSummary; tab: RepoTab; onTab(tab: RepoTab): void; onRepository?(repository: string): void } // onRepository: the fork's link to its original (#854)

// What a repository is in its workspace (#854): original · workspace, or fork de {original} › · workspace; any other, workspace {name}
function RepoContext({ summary, onRepository }: Pick<RepoHeader, 'summary' | 'onRepository'>) {
  const workspace = t('repos.workspace', { name: summary.workspace });
  const parent = summary.fork?.parent;
  if (summary.role === 'original') return <span className="flex-none whitespace-nowrap">{`${t('repos.original')} · ${workspace}`}</span>;
  if (summary.role !== 'fork' || parent === undefined) return <span>{workspace}</span>;
  return (
    <span className="flex-none whitespace-nowrap">
      {`${t('repos.forkOf')} `}
      <button type="button" className="text-foreground" onClick={() => onRepository?.(parent)}>{`${parent} ›`}</button>
      {` · ${workspace}`}
    </span>
  );
}

// The repository header (handoff 02, 03): the workspace square, the repository's name, workspace {name}, a divider, then PRs and issues with
// GitHub's open counts
function RepoTitle({ header }: { header: RepoHeader }) {
  const { summary } = header;
  const tab = (id: RepoTab, label: string, n: number | string) => (
    <button
      key={id} type="button" role="tab" aria-selected={header.tab === id} onClick={() => header.onTab(id)}
      className={`h-10 border-b-2 px-2 font-medium text-[13px] ${header.tab === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label} <span className="font-normal text-muted-foreground text-xs">{n}</span>
    </button>
  );
  return (
    <>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: workspaceColor(summary.workspace) }} />
      <span title={summary.repository} className="flex-none whitespace-nowrap font-semibold text-[13px] text-foreground">{summary.role === undefined ? repoName(summary.repository) : summary.repository}</span>
      <RepoContext summary={summary} onRepository={header.onRepository} />
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
      <div role="tablist" className="flex gap-0.5 self-stretch">{tab('prs', t('repos.tab.prs'), summary.openPrs)}{tab('issues', t('repos.tab.issues'), summary.issuesEnabled === false ? '—' : summary.openIssues)}</div>
    </>
  );
}

// fluxo, the picked source or todas as sources, and the chips of the workspaces the shown tasks resolve to (#542)
function FlowTitle({ state, source, tasks }: { state: State; source?: string; tasks: Task[] }) {
  return (
    <>
      <span className="font-semibold text-[13px] text-foreground">{t('header.flow')}</span>
      <span>{source ?? t('flow.allSources')}</span>
      {shownWorkspaces(tasks, state).map((name) => (
        <span key={name} className="flex items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5">
          <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: workspaceColor(name) }} />
          {name}
        </span>
      ))}
    </>
  );
}

interface FlowHeaderProps {
  state: State; source?: string; tasks: Task[]; search?: string; onSearch?(term: string): void; // #757: absent on the issue page, which has nothing to search
  isShown?: boolean;
  tabs?: SourceTabs; // #756: an external source is picked: the source header
  onRefresh?(): Promise<unknown>; // #756: what atualizar runs instead of polling every source (the native view reads itself again); never rejects
  repository?: RepoHeader; // #757: a repository is picked: the repository header
  loops?: boolean; onLoops?(): void; // #909: the flowchart's ↺ voltas; only Flow passes them, so the native tab and the repository headers never show it
}

/** The flow's header (redesign 10, #542): fluxo, the picked source or todas as sources, the chips of the workspaces the shown tasks resolve
 * to, ↺ voltas with `onLoops` (#909), buscar tarefas, the last poll and atualizar, which polls every source as the sidebar's atualizar agora does. `tasks`: the source pick's.
 * With `tabs` it is the source header instead (#756, handoff 01), on both tabs, with no chips and no last poll; with
 * `repository` the repository header (#757, handoff 02): no chips, no last poll, a narrower search. */
export function FlowHeader({ state, source, tasks, search, onSearch, isShown = true, tabs, onRefresh, repository, loops = true, onLoops }: FlowHeaderProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isOwn = tabs !== undefined || repository !== undefined;
  const polled = isOwn ? undefined : lastPolled(state.syncs, source);
  const refresh = (): void => {
    setIsRefreshing(true);
    void (onRefresh ?? (() => act('/sources/refresh')))().finally(() => setIsRefreshing(false)); // neither rejects: a refusal is its toast
  };
  // refreshFlow (#585): atualizar's own refresh, only while the flow shows (the header stays mounted under Atividades, #596). The listener
  // subscribes once per showing and reads the latest render's refresh
  const refreshKey = useRef(refresh);
  useEffect(() => {
    refreshKey.current = refresh;
  });
  useEffect(() => (isShown ? onShortcutKey([[true, 'refreshFlow']], () => refreshKey.current()) : undefined), [isShown]);
  const title = repository
    ? <RepoTitle header={repository} />
    : tabs ? <SourceTitle name={source ?? ''} tabs={tabs} /> : <FlowTitle state={state} source={source} tasks={tasks} />;
  return (
    <section aria-label={t('header.flow')} className="flex h-10 shrink-0 items-center gap-2.5 border-b px-3.5 text-muted-foreground text-xs">
      {title}
      <span className="flex-1" />
      {onLoops && (
        <Button type="button" variant="outline" size="xs" aria-pressed={loops} title={t(loops ? 'flow.loops.hide' : 'flow.loops.show')} className={loops ? LOOPS_ON : LOOPS_OFF} onClick={onLoops}>
          {t('flow.loops')}
        </Button>
      )}
      {onSearch && <SearchField label={t(repository ? 'repos.search' : 'flow.search')} value={search ?? ''} isShown={isShown} isNarrow={isOwn} onChange={onSearch} />}
      {polled !== undefined && <span>{t('flow.updated', { time: polled })}</span>}
      <Button type="button" variant="outline" size="xs" disabled={isRefreshing} onClick={refresh}>
        {t('flow.refresh')}<ButtonKeyHint id="refreshFlow" />
      </Button>
    </section>
  );
}
