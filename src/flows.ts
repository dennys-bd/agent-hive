import type { Flow, Stage, Transition } from './types.js';

// #564: the comb's flows and the one flattened view every stage-level reader keeps using. Types only, so the UI imports it too.

/** The name a flat comb (before #564) and a flat state.json get: neutral for any user, who renames it in Settings (#565). */
export const MAIN_FLOW = 'main';

export const flatten = (flows: readonly Flow[]): { stages: Stage[]; transitions: Transition[] } =>
  ({ stages: flows.flatMap((f) => f.stages), transitions: flows.flatMap((f) => f.transitions) });

// Stage names are unique across the comb (decision 4), so a stage name alone places a task in its flow
export const flowOf = (flows: readonly Flow[], stage: string): Flow | undefined => flows.find((f) => f.stages.some((s) => s.name === stage));

export const isFlowName = (value: unknown): value is string => typeof value === 'string' && value !== '' && value === value.trim();
