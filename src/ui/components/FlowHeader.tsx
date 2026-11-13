import { ExternalLinkIcon, SearchIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { repoName } from '../../pull-requests';
import { displayBinding } from '../../shortcuts';
import type { HIVE_SOURCE } from '../../tasks';
import type { RepoSummary, SourceConfig, SourceSync, State } from '../../types';
import { act } from '@/components/actions';
import { ButtonKeyHint, KeyHint } from '@/components/KeyHint';
import { HeaderSlot } from '@/components/HeaderSlot';
import { useIsFlowShown } from '@/components/MainDock';
import { Button } from '@/components/ui/button';
import { useBackKeys } from '@/hooks/use-back-keys';
import { CreateTaskOpenContext } from '@/hooks/use-create-task-dialog';
import { t } from '@/i18n';
import { CreateTargetsContext } from '@/lib/create-targets';
import { isSettingsClosed, onShortcutKey } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

const pad = (n: number): string => String(n).padStart(2, '0');

// The bar sits in the window header (#295), which drags the window (#583): its controls opt out to keep their clicks; its text drags with it
const NO_DRAG_CONTROLS = '[&_:is(button,input)]:[-webkit-app-region:no-drag]';

/** The latest poll among the shown sources (#542): the picked one, or every one; local 24h HH:MM, undefined while none has polled. */
export function lastPolled(syncs: Record<string, SourceSync>, source?: string): string | undefined {
  const times = Object.entries(syncs).flatMap(([name, status]) => ((source === undefined || name === source) && status.polledAt ? [status.polledAt] : []));
  const latest = times.sort().at(-1); // ISO strings sort as the instants they name
  if (latest === undefined) return undefined;
  const time = new Date(latest);
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** A page's way back (#911, #380): the last flow's label and what shows it again. */
export interface BackLink { label: string; onBack(): void }

// voltar · ⌘[ (#911): the key as bound now, so a rebound one shows; the words alone while it is off
function backTitle(): string {
  const keys = binding('goBack');
  return keys === null ? t('shortcuts.goBack') : t('back.title', { key: displayBinding(keys, isMac()) });
}

// The back button (#911, handoff §7): ‹ and the last flow's label (#380), then a divider before the name. ⌘[ and the mouse's back button do the
// same, but only while the flow shows: the header stays mounted under Atividades (#596), where the button is out of sight
function BackButton({ back }: { back: BackLink }) {
  const isShown = useIsFlowShown();
  useBackKeys(isShown ? back.onBack : undefined);
  return (
    <>
      <button
        type="button" title={backTitle()} onClick={back.onBack}
        className="flex max-w-[220px] shrink-0 items-center gap-1 rounded-[6px] border bg-background py-[3px] pr-2 pl-1.5 font-medium text-foreground text-xs hover:bg-muted"
      >
        <span aria-hidden="true" className="text-muted-foreground">‹</span>
        <span className="truncate">{back.label}</span>
      </button>
      <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
    </>
  );
}

// buscar tarefas (#542), or the repository's search (#757): the searchTasks key focuses it; the header stays mounted under Atividades (#596), so the key is bound only while the flow shows. Esc clears
// it and leaves, and its preventDefault keeps the detail panel's own Escape (#426) from closing the panel too. 200px in a source's or a repository's header (#756)
function SearchField({ label, value, isShown, isNarrow, onChange }: { label: string; value: string; isShown: boolean; isNarrow: boolean; onChange(term: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => (isShown ? onShortcutKey([[true, 'searchTasks']], () => input.current?.focus(), isSettingsClosed) : undefined), [isShown]);
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

// The source header (handoff §2): its name, then its type and owner, muted. The hive source (#572, #583) has neither: its second part says
// what it is, tasks of its own that no source syncs
function SourceHeading({ source }: { source: SourceConfig | typeof HIVE_SOURCE }) {
  const name = <span className="font-semibold text-[13px] text-foreground">{typeof source === 'string' ? source : source.name}</span>;
  if (typeof source === 'string') return <>{name}<span>{t('tasks.header.hive')}</span></>;
  return <>{name}<span>{`${t(`tasks.header.source.${source.type}`)} · ${source.owner}`}</span></>;
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
      <WorkspaceSquare name={summary.workspace} />
      <span title={summary.repository} className="flex-none whitespace-nowrap font-semibold text-[13px] text-foreground">{summary.role === undefined ? repoName(summary.repository) : summary.repository}</span>
      <RepoContext summary={summary} onRepository={header.onRepository} />
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
      <div role="tablist" className="flex gap-0.5 self-stretch">{tab('prs', t('repos.tab.prs'), summary.openPrs)}{tab('issues', t('repos.tab.issues'), summary.issuesEnabled === false ? '—' : summary.openIssues)}</div>
    </>
  );
}

/** What the header is for (#571): the tasks view, a source's table and pages, or a repository's lists and pages. */
export type HeaderMode = { kind: 'tasks' } | { kind: 'source'; source: SourceConfig | typeof HIVE_SOURCE } | { kind: 'repo'; header: RepoHeader };
const TASKS_MODE: HeaderMode = { kind: 'tasks' };

// fluxo, the sources legend (#574) and the display slot; the workspaces are the canvas legend's (#576)
function TasksTitle({ legend, display }: { legend?: string; display?: ReactNode }) {
  return (
    <>
      <span className="font-semibold text-[13px] text-foreground">{t('header.flow')}</span>
      <span>{legend ?? t('tasks.display.allSources')}</span>
      {display}
    </>
  );
}

// GitHub ↗ (#352): what the center shows, on GitHub. window.open is what the main window hands to the default browser, as every other
// "open on github" does. The xs outline is atualizar's; its base keeps it from shrinking, so the search gives way first
function GithubButton({ url }: { url: string }) {
  return (
    <Button type="button" variant="outline" size="xs" title={t('header.github.title')} onClick={() => window.open(url, '_blank', 'noreferrer')}>
      {t('header.github')}<ExternalLinkIcon aria-hidden="true" className="text-muted-foreground" />
    </Button>
  );
}

// + criar tarefa (#774, tasks.hv.html): the source header's way into the create-task dialog, opened on that source. Only where the dialog can
// create in it (decision 8): the hive source while hive is on, a GitHub source with a repository for new issues. None outside the dock (decision 11)
function SourceCreateButton({ source }: { source: SourceConfig | typeof HIVE_SOURCE }) {
  const open = useContext(CreateTaskOpenContext);
  const { hiveSource, sources } = useContext(CreateTargetsContext);
  const name = typeof source === 'string' ? source : source.name;
  const canCreate = typeof source === 'string' ? hiveSource : sources.some((s) => s.name === name);
  if (open === undefined || !canCreate) return null;
  return (
    <Button type="button" variant="outline" size="xs" title={t('header.createTask.title')} onClick={() => open({ source: name })}>
      {t('header.createTask')}
    </Button>
  );
}

interface FlowHeaderProps {
  state: State; search?: string; onSearch?(term: string): void; // #757: absent on the issue page, which has nothing to search
  isShown?: boolean;
  onRefresh?(): Promise<unknown>; // #756: what atualizar runs instead of polling every source (the native view reads itself again); never rejects
  mode?: HeaderMode; // #571: tasks (default), a source (#756) or a repository (#757)
  legend?: string; // #574: the tasks mode's sources legend; absent: todas as sources
  display?: ReactNode; // #571: the tasks mode's display control (exibir, #574), right after the legend
  back?: BackLink; // #911, #380: the way back to the last flow; only the issue and PR pages pass it
  github?: string; // #352: the GitHub page of what the center shows; only the repository views and the issue/PR pages pass it
}

/** The flow's header (redesign 10, #542): fluxo, the sources legend and exibir (#574), buscar tarefas, the last poll and atualizar, which polls every source as the sidebar's atualizar agora does.
 * With `mode` source it is the source header (#756, handoff §2) and with `mode` repo the repository header (#757, handoff 02): no last poll, a narrower search. With `back` (#911) it starts with the back button. With `github` (#352), GitHub ↗ sits right before atualizar. With mode source and inside the dock, + criar tarefa (#774) sits before the search. It renders in the window header's center column (#295, HeaderSlot),
 * the header's 44px and border its own. */
export function FlowHeader({ state, search, onSearch, isShown = true, onRefresh, mode = TASKS_MODE, legend, display, back, github }: FlowHeaderProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isTasks = mode.kind === 'tasks';
  const polled = isTasks ? lastPolled(state.syncs) : undefined;
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
  const title = mode.kind === 'repo' ? <RepoTitle header={mode.header} /> : mode.kind === 'source' ? <SourceHeading source={mode.source} /> : <TasksTitle legend={legend} display={display} />;
  return (
    <HeaderSlot>
    <section aria-label={t('header.flow')} className={`flex h-full min-w-0 flex-1 items-center gap-2.5 px-3.5 text-muted-foreground text-xs ${NO_DRAG_CONTROLS}`}>
      {back && <BackButton back={back} />}
      {title}
      <span className="flex-1" />
      {mode.kind === 'source' && <SourceCreateButton source={mode.source} />}
      {onSearch && <SearchField label={t(mode.kind === 'repo' ? 'repos.search' : 'flow.search')} value={search ?? ''} isShown={isShown} isNarrow={!isTasks} onChange={onSearch} />}
      {polled !== undefined && <span>{t('flow.updated', { time: polled })}</span>}
      {github !== undefined && !isTasks && <GithubButton url={github} />}
      <Button type="button" variant="outline" size="xs" disabled={isRefreshing} onClick={refresh}>
        {t('flow.refresh')}<ButtonKeyHint id="refreshFlow" />
      </Button>
    </section>
    </HeaderSlot>
  );
}
