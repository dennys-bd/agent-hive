import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import type { Experiment } from '../../../types';
import { BenchmarkSidebar } from '@/components/benchmark/BenchmarkSidebar';
import { BenchmarkView } from '@/components/benchmark/BenchmarkView';
import type { DockPanel } from '@/components/DockGroup';
import { groupExperiments, type SidebarGroups } from '@/components/benchmark/sidebar-groups';
import type { TabId } from '@/components/benchmark/tabs';
import { statusOf } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { sendJson } from '@/lib/api';
import type { PanelId } from '@/lib/dock-layout';

/** What later leaves plug into the shell (#461): pedir ao agente (5), exportar report.md (2.7), dormir (2.8). Absent: the item is left out, or
 * dormir sits disabled. */
export interface BenchmarkSlots { askAgent?(): void; exportReport?(experiment: Experiment): void; sleep?(experiment: Experiment): void }

export interface Benchmark {
  experiments: readonly Experiment[]; sidebar: SidebarGroups; isEmpty: boolean; // isEmpty: no live (non-archived) experiment
  selected?: Experiment; select(id: string): void;
  tab: TabId; setTab(tab: TabId): void;
  query: string; setQuery(query: string): void;
  isArchivedOpen: boolean; toggleArchived(): void;
  createEmpty(workspace: string): Promise<void>; duplicate(of: string): Promise<void>; // each selects the answer's draft
  rename(id: string, name: string): Promise<void>; setArchived(id: string, archived: boolean): Promise<void>;
  remove(id: string): Promise<void>; // selects the next experiment in the sidebar, or none
  slots: BenchmarkSlots;
}

const E = '/benchmark/experiments';
const pathOf = (id: string): string => `${E}/${encodeURIComponent(id)}`;
const NO_SLOTS: BenchmarkSlots = {};
// A refusal's status as the copy the toast shows (root design, Routes): the route logs a 500's detail; its words never reach the screen
const FAILED: Readonly<Record<number, MessageKey>> = { 400: 'benchmark.header.failed.invalid', 404: 'benchmark.header.failed.gone', 409: 'benchmark.header.failed.running' };

// The answer, or undefined once the toast told why
async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
  try {
    return await sendJson<T>(method, path, body);
  } catch (err) {
    toast.error(t(FAILED[statusOf(err)] ?? 'benchmark.header.failed.unknown'));
    return undefined;
  }
}

// The live rows in the sidebar's order, unfiltered: what the first selection and "the next experiment" after a delete read
const rowsOf = (experiments: readonly Experiment[]): Experiment[] => groupExperiments(experiments, '').groups.flatMap((g) => g.experiments);

/** The benchmark view's state (#461): the selection, the tab, the search and the archived toggle, kept in the always-mounted dock so they survive a
 * switch of view, not a restart. The experiments are the state's; every write posts its route and the /events stream brings the result. */
export function useBenchmark(experiments: readonly Experiment[], slots: BenchmarkSlots = NO_SLOTS): Benchmark {
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<TabId>('arms');
  const [query, setQuery] = useState('');
  const [isArchivedOpen, setArchivedOpen] = useState(false);
  const rows = rowsOf(experiments);
  // A fresh draft is selected by id before the stream delivers it, so the first row shows for that moment
  const selected = experiments.find((e) => e.id === selectedId) ?? rows[0];
  const create = async (body: object): Promise<void> => {
    const answer = await send<Experiment>('POST', E, body);
    if (answer !== undefined) setSelectedId(answer.id);
  };
  const patch = async (id: string, body: object): Promise<void> => void (await send('PATCH', pathOf(id), body));
  const remove = async (id: string): Promise<void> => {
    const at = rows.findIndex((e) => e.id === id);
    const next = at === -1 ? undefined : (rows[at + 1] ?? rows[at - 1]);
    if ((await send('DELETE', pathOf(id))) !== undefined) setSelectedId(next?.id);
  };
  return {
    experiments, sidebar: groupExperiments(experiments, query), isEmpty: rows.length === 0, selected, select: setSelectedId, tab, setTab, query, setQuery,
    isArchivedOpen, toggleArchived: () => setArchivedOpen((open) => !open),
    createEmpty: (workspace) => create({ kind: 'empty', workspace }), duplicate: (of) => create({ kind: 'duplicate', of }),
    rename: (id, name) => patch(id, { name }), setArchived: (id, archived) => patch(id, { archived }), remove, slots,
  };
}

export interface BenchmarkDock { panel: DockPanel; right: DockPanel; center: ReactNode }
interface BenchmarkDockArgs { isShown: boolean; experiments: readonly Experiment[]; workspaces: readonly string[]; activate(id: PanelId): void; slots?: BenchmarkSlots }

/** The benchmark view in the dock (#461), beside MainDock, which is at its line limit: the sidebar as the left column's panel, an empty right
 * body while the view is shown (no health pane yet), and the centre. The state lives here, in the always-mounted dock, so the selection and the
 * tab survive a switch of view. */
export function useBenchmarkDock({ isShown, experiments, workspaces, activate, slots }: BenchmarkDockArgs): BenchmarkDock {
  const benchmark = useBenchmark(experiments, slots);
  return {
    panel: { id: 'benchmark', title: t('dock.benchmark'), ownHeader: true, body: <BenchmarkSidebar benchmark={benchmark} workspaces={workspaces} isShown={isShown} activate={activate} /> },
    right: { id: 'detail', title: t('dock.benchmark'), ownHeader: true, body: <section aria-label={t('dock.benchmark')} className="flex min-h-0 flex-1 flex-col" /> },
    center: isShown ? <BenchmarkView benchmark={benchmark} workspaces={workspaces} /> : null,
  };
}
