// The coding agents a stage can run (#516): each one's facts, which of them this machine has, and which one a stage runs.
// Only claude exists; #101 adds an entry here and a spawn path in ptyCommand.
import { AGENT_IDS, type AgentAvailability, type AgentId, type Config, type Exec, type Stage } from './types.js';

export interface AgentSpec {
  label: string; // how a run tab names it
  command: string; // the CLI on PATH, probed with --version
  modelFlag: string; // what `modelo` is passed behind, as typed
  protocolFlag: string; // what the Hive's protocol file is passed behind (#167): appended to the agent's own system prompt, never replacing it
  subcommands: readonly string[]; // the CLI's own commands (#696): the claude shim runs them straight through, never as a conversation
}

// A Record, so a new id in AGENT_IDS fails tsc until its entry exists, protocol flag included.
export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    label: 'Claude', command: 'claude', modelFlag: '--model', protocolFlag: '--append-system-prompt-file',
    // as `claude --help` lists them, aliases included
    subcommands: [
      'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'kill', 'logs', 'mcp', 'plugin', 'plugins', 'purge',
      'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade',
    ],
  },
};

/** Every agent, available: what the server assumes when nothing was detected (tests only: boot always detects). */
export const ALL_AGENTS: AgentAvailability[] = AGENT_IDS.map((agent) => ({ agent, available: true }));

/** Checks every agent's CLI once, in parallel, with the daemon's own env: the PATH the worker's pty resolves the command with. */
export async function detectAgents(exec: Exec): Promise<AgentAvailability[]> {
  const found = await Promise.all(AGENT_IDS.map((id) => exec(AGENTS[id].command, ['--version']).then(() => true, () => false)));
  return AGENT_IDS.map((agent, i) => ({ agent, available: found[i] }));
}

/** The agent a stage runs: its own, else the config's default. */
export const agentOf = (stage: Pick<Stage, 'agent'>, config: Pick<Config, 'defaultAgent'>): AgentId => stage.agent ?? config.defaultAgent;

/** Why a run of `agent` cannot start, or undefined: an agent boot did not find (or never checked) is refused before any worktree. */
export function agentRefusal(agent: AgentId, agents: readonly AgentAvailability[]): string | undefined {
  return agents.some((a) => a.agent === agent && a.available) ? undefined : `agent ${agent} is not on PATH: install it, then restart the Hive`;
}
