import { MAIN_FLOW } from '../../src/flows';
import type { Flow, State } from '../../src/types';

/** The flow a direct <Flow> render draws (#571). With one flow (or none) it draws the state's flat stages and transitions, since hand-built
 * test states override `stages` and `transitions` after `flowed()` and leave `flows` stale; with several it is the first one. */
export const firstFlow = (state: State): Flow =>
  state.flows.length > 1 ? state.flows[0] : { name: state.flows[0]?.name ?? MAIN_FLOW, stages: state.stages, transitions: state.transitions };
