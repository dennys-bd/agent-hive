import { MAIN_FLOW } from '../../src/flows.js';
import type { Flow, Stage, State, Transition } from '../../src/types.js';

/** A fixture's stages as the one flow a flat comb migrates to (#564): what a hand-built CombConfig or State wraps its stages with. */
export const mainFlows = (stages: Stage[], transitions: Transition[] = []): Flow[] => [{ name: MAIN_FLOW, stages, transitions }];

/** The state's three flow keys for those stages (#564): one main flow and its flattened pair, what a hand-built State spreads. */
export const flowed = (stages: Stage[], transitions: Transition[] = []): Pick<State, 'flows' | 'stages' | 'transitions'> => ({ flows: mainFlows(stages, transitions), stages, transitions });
