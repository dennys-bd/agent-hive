import { createContext } from 'react';
import { HIVE_SOURCE } from '../../tasks.js';
import type { SourceConfig } from '../../types.js';

/** Where a task may be created from the UI (#846): hive while it is on, the default destination, and every source with a repository. */
export interface CreateTargets { hiveSource: boolean; createIn: string; sources: string[] }

/** No config handed (a test harness, a dialog outside the Dashboard): today's behaviour. */
export const HIVE_ONLY: CreateTargets = { hiveSource: true, createIn: HIVE_SOURCE, sources: [] };

export const createTargetsOf = (nav: { sources: SourceConfig[]; hiveSource?: boolean; createIn?: string }): CreateTargets => ({
  hiveSource: nav.hiveSource !== false, createIn: nav.createIn ?? HIVE_SOURCE,
  sources: nav.sources.flatMap((s) => (s.repository === undefined ? [] : [s.name])),
});

/** The destinations a create row offers, the default first; hive only while it is on. */
export function destinations({ hiveSource, createIn, sources }: CreateTargets): string[] {
  const all = [...(hiveSource ? [HIVE_SOURCE] : []), ...sources];
  return [createIn, ...all.filter((name) => name !== createIn)];
}

/** Provided by the Dashboard, read by the Start dialog and fluxo… (#846) without threading props through the dock, the tables and the pages. */
export const CreateTargetsContext = createContext<CreateTargets>(HIVE_ONLY);
