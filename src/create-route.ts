import { entryFor } from './task-entry.js';
import { matchesRules } from './task-filter.js';
import { matchTaskProps } from './task-props.js';
import type { FilterRule, Flow, ItemFacets, SourceConfig, TaskEntry } from './types.js';

// Where a source's rules place an issue that does not exist yet (#769): the create dialog's preview. It runs the poll's own functions over a
// draft read the way the adapter reads a polled item (facetsOf, itemReader), so the preview and the poll cannot disagree. No Node imports:
// the UI bundles it.

export interface CreateDraft { source: string; title: string; labels: string[]; status: string | null }

export type RouteReason = { kind: 'status'; status: string } | { kind: 'rule'; index: number } | { kind: 'defaults' };
export type RouteMiss =
  | { kind: 'offProject' }
  | { kind: 'status'; status: string }
  | { kind: 'filter'; index: number; rule: FilterRule }
  | { kind: 'source' };
export type CreateRoute =
  | { taken: true; workspace?: string; entry: { flow: string; stage: string } | null; reason: RouteReason; workspaceRule?: number }
  | { taken: false; missed: RouteMiss };

const missed = (miss: RouteMiss): CreateRoute => ({ taken: false, missed: miss });

/** facetsOf's counterpart: a new issue has no assignee, milestone or Project field besides Status, and facets leave Status out. */
export const draftFacets = (draft: CreateDraft, source: SourceConfig): ItemFacets =>
  ({ assignees: [], labels: draft.labels, ...(source.repository === undefined ? {} : { repository: source.repository }), fields: {} });

/** itemReader's counterpart: what a task-properties rule reads of the draft. */
export const draftReader = (draft: CreateDraft) => (field: string): string[] => {
  if (field === 'title') return [draft.title];
  if (field === 'labels') return draft.labels;
  return field === 'Status' && draft.status !== null ? [draft.status] : [];
};

// 0-based position of the first rule that matches and sets the property, as rules[i] in the config; undefined when no rule does
const ruleSetting = (source: SourceConfig, read: (field: string) => string[], key: 'entry' | 'workspace'): number | undefined => {
  const index = source.taskProps.rules.findIndex((rule) => key in matchTaskProps([rule], read));
  return index === -1 ? undefined : index;
};

const failedFilter = (source: SourceConfig, facets: ItemFacets): RouteMiss | undefined => {
  const index = source.filter.findIndex((rule) => !matchesRules([rule], { facets }, undefined));
  return index === -1 ? undefined : { kind: 'filter', index, rule: source.filter[index] };
};

/** The stage the entry property asked for, when entryFor kept it rather than falling back to the column's door. */
const asked = (entry: TaskEntry | undefined, flow: Flow, stage: string): boolean =>
  entry !== undefined && entry !== null && entry.flow === flow.name && (entry.stage ?? flow.stages[0]?.name) === stage;

export function routeOf(draft: CreateDraft, sources: readonly SourceConfig[], flows: readonly Flow[]): CreateRoute {
  const source = sources.find((s) => s.name === draft.source);
  if (source === undefined) return missed({ kind: 'source' });
  if (draft.status === null) return missed({ kind: 'offProject' });
  const { status } = draft;
  const facets = draftFacets(draft, source);
  const filterMiss = failedFilter(source, facets);
  if (filterMiss !== undefined) return missed(filterMiss);

  const read = draftReader(draft);
  const { workspace: ruled, entry: ruledEntry } = matchTaskProps(source.taskProps.rules, read);
  const { defaults } = source.taskProps;
  const workspace = ruled === undefined ? defaults.workspace : ruled;
  const entry = ruledEntry === undefined ? defaults.entry : ruledEntry; // never ??: null (outside the flow) is a value
  const entryRule = ruledEntry === undefined ? undefined : ruleSetting(source, read, 'entry');
  const workspaceRule = ruled === undefined ? undefined : ruleSetting(source, read, 'workspace');

  const stage = entryFor(flows, { item: { itemId: `${source.name}:draft`, id: '', title: draft.title, body: '', url: '', source: source.name, entry, facets }, column: status });
  if (stage === undefined) return missed({ kind: 'status', status });
  const flow = stage === null ? undefined : flows.find((f) => f.stages.includes(stage));
  const byRule = entryRule !== undefined && (stage === null || (flow !== undefined && asked(entry, flow, stage.name)));
  return {
    taken: true,
    ...(workspace === undefined ? {} : { workspace }),
    entry: stage === null || flow === undefined ? null : { flow: flow.name, stage: stage.name },
    reason: byRule ? { kind: 'rule', index: entryRule } : stage === null ? { kind: 'defaults' } : { kind: 'status', status },
    ...(workspaceRule === undefined ? {} : { workspaceRule }),
  };
}
