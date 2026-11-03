import { MAIN_FLOW } from '../../src/flows.js';
import type { Flow, Stage, Transition } from '../../src/types.js';

/** A fixture's stages as the one flow a flat comb migrates to (#564): what a hand-built CombConfig or State wraps its stages with. */
export const mainFlows = (stages: Stage[], transitions: Transition[] = []): Flow[] => [{ name: MAIN_FLOW, stages, transitions }];
