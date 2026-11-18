// Copilot's headless runs (#330), node 5 of #608: none yet
import { join } from 'node:path';
import type { HeadlessRun } from './runner.js';

export const HEADLESS_MCP = false; // no tester MCP config until node 5

export const headless = (): string[] => {
  throw new Error('copilot: headless runs are not supported yet');
};

export const headlessAnswer = (): string | undefined => undefined;

const HOME_DIR = 'copilot-home';
const SCHEMA_INSTRUCTION = '\n\nAnswer with one JSON object that matches this JSON Schema, and nothing else: no prose, no code fence.\n\n';

/** Copilot has no schema flag (spike §4): the prompt asks for the JSON the callers' parsers read, the schema last. */
export const headlessPrompt = (prompt: string, schema: string): string => `${prompt}${SCHEMA_INSTRUCTION}${schema}`;

// A fresh home trusts no folder, so a worktree's repository hooks never load (probes A, B, D), and it holds the session folder Copilot always
// writes (no --no-session-persistence, spike §4), which goes with the run's folder. COPILOT_ALLOW_ALL exactly "true" would trust the cwd
// again (`copilot help environment`); empty is off, whatever was inherited. No update check per run, as #873's workers
export const headlessEnv = ({ dir }: HeadlessRun): Record<string, string> =>
  ({ COPILOT_HOME: join(dir, HOME_DIR), COPILOT_AUTO_UPDATE: 'false', COPILOT_ALLOW_ALL: '' });
