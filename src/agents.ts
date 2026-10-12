// The coding agents a stage can run (#516): each one's facts, which of them this machine has, and which one a stage runs.
// Page-safe facts only (#924): the page imports this file. Each agent's runner, which reads files and runs processes, is in agents/registry.ts.
import { AGENT_IDS, DEFAULT_AGENT, type AgentAvailability, type AgentId, type Config, type Exec, type Stage, type State } from './types.js';

export interface AgentSpec {
  label: string; // how a run tab names it
  command: string; // the CLI on PATH, probed with --version, which a run's command line starts with and its shim is named after
  subcommands: readonly string[]; // the shim's first-arg passthrough (#696, #932): the CLI's own commands and any that open a session the user chose
  shimFlags: readonly string[]; // #932: sh case patterns that pass the shim through in any position: a session the user chose, or no conversation
  planLimits: boolean; // #925: the Hive reads this agent's plan limits (its runner's planLimits), so the header offers their refresh
  canChooseSessionId: boolean; // #927: a run opens under an id the Hive chose; one that cannot (Codex) learns it from its first SessionStart, its free and local sessions too (#931)
}

// A Record, so a new id in AGENT_IDS fails tsc until its entry exists; its runner joins agents/registry.ts the same way (#924).
export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    label: 'Claude', command: 'claude', planLimits: true, canChooseSessionId: true,
    // as `claude --help` lists them, aliases included
    subcommands: [
      'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'kill', 'logs', 'mcp', 'plugin', 'plugins', 'purge',
      'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade',
    ],
    shimFlags: ['--resume', '--resume=*', '-r', '--continue', '-c', '--session-id', '--session-id=*', '-p', '--print', '-h', '--help', '-v', '--version'],
  },
  codex: {
    label: 'Codex', command: 'codex', planLimits: true, canChooseSessionId: false, // planLimits: #929, read from its rollouts
    // as `codex --help` lists them (finding §12), aliases included; resume and fork open a session the user chose, which the shim runs as typed,
    // as Claude's --resume (#932)
    subcommands: [
      'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor',
      'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'help',
      'resume', 'fork',
    ],
    shimFlags: ['-h', '--help', '-V', '--version'], // #932: no -c, which is a config override in Codex
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

/** What every run before #925 ran: a saved session or worker with no agent was Claude's. Frozen, not DEFAULT_AGENT, so a later default never
 * relabels old runs (config-migrate.ts freezes its own for the same reason). */
export const LEGACY_RUN_AGENT: AgentId = 'claude';

/** `value` when AGENT_IDS has it (#925): what an open route's kind and a saved run's agent are checked against. */
export const knownAgent = (value: unknown): AgentId | undefined => AGENT_IDS.find((id) => id === value);

/** A saved run's agent (#925): its own when known, else LEGACY_RUN_AGENT. */
export const savedAgent = (value: unknown): AgentId => knownAgent(value) ?? LEGACY_RUN_AGENT;

/** What a worker or a live agent run runs (#925): its own agent. The reducer and the loader always set it; only a literal built without one
 * (a test's) reads as LEGACY_RUN_AGENT, the rule a saved run follows. */
export const ranAgent = (run: { agent?: AgentId }): AgentId => run.agent ?? LEGACY_RUN_AGENT;

/** The config's default agent as the live state holds it (#925); DEFAULT_AGENT on a state built without one. */
export const liveDefaultAgent = (state: Pick<State, 'defaultAgent'>): AgentId => state.defaultAgent ?? DEFAULT_AGENT;

/** The agent a stage runs, read in the reducer (#925): agentOf against the live state's default. */
export const stageAgentIn = (state: Pick<State, 'defaultAgent'>, stage: Pick<Stage, 'agent'>): AgentId =>
  agentOf(stage, { defaultAgent: liveDefaultAgent(state) });

/** An agent as the UI and a review mention name it (#536, #925): its own label, lowercase as every label is. The one agent-to-label map. */
export const agentName = (agent: AgentId): string => AGENTS[agent].label.toLowerCase();

/** Whether boot found `agent` on PATH (#516); one it never checked is not. The menus that open a session disable the others (#931). */
export const isAvailable = (agent: AgentId, agents: readonly AgentAvailability[]): boolean => agents.some((a) => a.agent === agent && a.available);

/** Why a run of `agent` cannot start, or undefined: an agent boot did not find (or never checked) is refused before any worktree. */
export function agentRefusal(agent: AgentId, agents: readonly AgentAvailability[]): string | undefined {
  return isAvailable(agent, agents) ? undefined : `agent ${agent} is not on PATH: install it, then restart the Hive`;
}
