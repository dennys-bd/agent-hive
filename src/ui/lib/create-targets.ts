import { createContext } from 'react';
import { canCreate, type CanCreate } from '../../create-in.js';
import { HIVE_SOURCE } from '../../tasks.js';
import type { SourceConfig, SourceFields } from '../../types.js';

/** A create row's destination (#846): a source carries its type, which criar em names under it (#893); hive carries none. */
export interface Destination { name: string; type?: SourceFields['type'] }

/** A source a task may be created in (#846); its repository for new issues, when its type has one, names it in the create dialog's menu (#772, #811). */
export type CreateSource = Required<Destination> & { repository?: string };

/** Where a task may be created from the UI (#846): hive while it is on, the default destination, and every source that can create (canCreate), which the create dialog names (#772). */
export interface CreateTargets {
  hiveSource: boolean; createIn: string; sources: CreateSource[];
  configs?: readonly SourceConfig[]; // the full configs, which the route box (#773) runs routeOf over; absent = none
}

/** The create dialog's opening destination (#772, decision 1); hinted = rule 2 picked it, the one case the switch says why (decision 2). */
export interface Preselected { destination: 'hive' | 'github'; source?: string; hinted: boolean }

/** No config handed (a test harness, a dialog outside the Dashboard): today's behaviour. */
export const HIVE_ONLY: CreateTargets = { hiveSource: true, createIn: HIVE_SOURCE, sources: [] };

export const createTargetsOf = (nav: { sources: readonly SourceConfig[]; hiveSource?: boolean; createIn?: string }, can: CanCreate = canCreate): CreateTargets => ({
  hiveSource: nav.hiveSource !== false, createIn: nav.createIn ?? HIVE_SOURCE, configs: nav.sources,
  sources: nav.sources.flatMap((s) => (can(s) ? [{ name: s.name, type: s.type, ...(s.repository === undefined ? {} : { repository: s.repository }) }] : [])),
});

/** The destinations a create row offers, the default first; hive only while it is on. */
export function destinations({ hiveSource, createIn, sources }: CreateTargets): Destination[] {
  const all: Destination[] = [...(hiveSource ? [{ name: HIVE_SOURCE }] : []), ...sources];
  const first = all.find((d) => d.name === createIn) ?? { name: createIn };
  return [first, ...all.filter((d) => d.name !== createIn)];
}

/** Decision 1 of #772: an opening source wins; else the first source whose default workspace (state.sourceWorkspaces) is the opened one;
 * else hive. With no workspace, or hive off, createIn decides, and the first available destination when createIn names none of them. */
export function preselect(opened: { workspace?: string; source?: string }, targets: CreateTargets, sourceWorkspaces: Readonly<Record<string, string>>): Preselected {
  const { hiveSource, createIn, sources } = targets;
  const hive: Preselected = { destination: 'hive', hinted: false };
  const github = (source: string, hinted = false): Preselected => ({ destination: 'github', source, hinted });
  const isSource = (name: string | undefined): name is string => sources.some((s) => s.name === name);
  if (opened.source === HIVE_SOURCE && hiveSource) return hive;
  if (isSource(opened.source)) return github(opened.source);
  const byWorkspace = opened.workspace === undefined ? undefined : sources.find((s) => sourceWorkspaces[s.name] === opened.workspace);
  if (byWorkspace !== undefined) return github(byWorkspace.name, true);
  if (opened.workspace !== undefined && hiveSource) return hive;
  if (createIn === HIVE_SOURCE && hiveSource) return hive;
  if (isSource(createIn)) return github(createIn);
  // A createIn that names no available destination falls back to the first one that is
  return hiveSource || sources[0] === undefined ? hive : github(sources[0].name);
}

/** The repositório menu's line (#772, decision 4): the repository, and the source after it only when another source names the same one,
 * since the wire carries the source's name. */
// A source with no repository is named by its own name: there is no repository to share (#811)
export function repositoryLabel(source: CreateSource, sources: readonly CreateSource[]): string {
  if (source.repository === undefined) return source.name;
  const isShared = sources.filter((s) => s.repository === source.repository).length > 1;
  return isShared ? `${source.repository} · ${source.name}` : source.repository;
}

/** Provided by the Dashboard, read by the Start dialog and fluxo… (#846) without threading props through the dock, the tables and the pages. */
export const CreateTargetsContext = createContext<CreateTargets>(HIVE_ONLY);
