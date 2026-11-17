// Where Copilot keeps its sessions and its state (spike §6): the one lookup nodes 5, 6 and 8 of #608 share. Nothing reads or writes there yet (#873)
import { homedir } from 'node:os';
import { join } from 'node:path';

/** $COPILOT_HOME of `env` when set and not empty, else ~/.copilot, Copilot's own default. */
export const copilotHome = (env: NodeJS.ProcessEnv): string => (env.COPILOT_HOME ? env.COPILOT_HOME : join(homedir(), '.copilot'));
