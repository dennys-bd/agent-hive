// Where Copilot keeps its sessions and its state (spike §6): the one lookup nodes 5, 6 and 8 of #608 share. read only, never written (#873, #878). #880 reads its config.json (copilot-trust.ts)
import type { Machine, MachineInfo } from '../machine.js';

/** Copilot's home on a machine: its COPILOT_HOME when absolute, else `<its home>/.copilot`. A relative one would resolve against the daemon's cwd,
 * and deleting a session removes files there (#878), as codex's sessionsRoot treats CODEX_HOME. */
export function copilotHomeOf(info: Pick<MachineInfo, 'homedir' | 'copilotHome'>, paths: Machine['paths']): string {
  const configured = info.copilotHome?.trim();
  return configured && paths.isAbsolute(configured) ? configured : paths.join(info.homedir, '.copilot');
}
