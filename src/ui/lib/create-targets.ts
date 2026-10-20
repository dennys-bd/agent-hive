import { createContext } from 'react';
import { HIVE_SOURCE } from '../../tasks.js';
import type { SourceConfig, SourceFields } from '../../types.js';

/** A create row's destination (#846): a source carries its type, which criar em names under it (#893); hive carries none. */
export interface Destination { name: string; type?: SourceFields['type'] }

/** Where a task may be created from the UI (#846): hive while it is on, the default destination, and every source with a repository. */
export interface CreateTargets { hiveSource: boolean; createIn: string; sources: Required<Destination>[] }

/** No config handed (a test harness, a dialog outside the Dashboard): today's behaviour. */
export const HIVE_ONLY: CreateTargets = { hiveSource: true, createIn: HIVE_SOURCE, sources: [] };

export const createTargetsOf = (nav: { sources: readonly Pick<SourceConfig, 'name' | 'type' | 'repository'>[]; hiveSource?: boolean; createIn?: string }): CreateTargets => ({
  hiveSource: nav.hiveSource !== false, createIn: nav.createIn ?? HIVE_SOURCE,
  sources: nav.sources.flatMap((s) => (s.repository === undefined ? [] : [{ name: s.name, type: s.type }])),
});

/** The destinations a create row offers, the default first; hive only while it is on. */
export function destinations({ hiveSource, createIn, sources }: CreateTargets): Destination[] {
  const all: Destination[] = [...(hiveSource ? [{ name: HIVE_SOURCE }] : []), ...sources];
  const first = all.find((d) => d.name === createIn) ?? { name: createIn };
  return [first, ...all.filter((d) => d.name !== createIn)];
}

/** Provided by the Dashboard, read by the Start dialog and fluxo… (#846) without threading props through the dock, the tables and the pages. */
export const CreateTargetsContext = createContext<CreateTargets>(HIVE_ONLY);
