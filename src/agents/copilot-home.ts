// Where Copilot keeps its sessions and its state (spike §6): the one lookup nodes 5, 6 and 8 of #608 share. read only, never written (#873, #878)
import { isAbsolute, join } from 'node:path';
import type { MachineInfo } from '../machine.js';

/** Copilot's home on a machine: its COPILOT_HOME when absolute, else `<its home>/.copilot`. A relative one would resolve against the daemon's cwd,
 * and deleting a session removes files there (#878), as codex's sessionsRoot treats CODEX_HOME. */
export function copilotHomeOf(info: Pick<MachineInfo, 'homedir' | 'copilotHome'>): string {
  const configured = info.copilotHome?.trim();
  return configured && isAbsolute(configured) ? configured : join(info.homedir, '.copilot');
}
