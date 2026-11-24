// What a machine can run (#946, node 5.4 of #942): its agents, a distro's Claude login and gh, the status GET /machines lists, and the
// refusal of a run whose agent its machine cannot start. One place, so the page's list and every start and spawn read the same agents.
import { isAvailable, notOnPathRefusal } from '../agents.js';
import type { Machine } from '../machine.js';
import { machineRefusal } from '../machines.js';
import { isRecord } from '../remote/frames.js';
import { type AgentAvailability, type AgentId, type Config, type Language, type MachineAgent, type MachineId, type MachineStatus, WSL_MACHINE_PREFIX } from '../types.js';
import { tIn } from '../ui/i18n.js';
import { HELPER_FAILED } from './helper-install.js';

export const AUTH_TIMEOUT_MS = 15_000; // decision 3: a claude auth status that hangs reads as logged out instead of holding the start
export const READY = 'ready';
export const STOPPED = 'stopped'; // decision 1: a distro wsl.exe does not list as running
export const AGENT_UNAVAILABLE = 'agent_unavailable';
export const AGENT_LOGGED_OUT = 'agent_logged_out';
const DISTRO_AGENT: AgentId = 'claude'; // decision 5: Codex's and Copilot's runners write home files on the host, which nothing writes in a distro
const ROOT = '/'; // a distro's disk always has it: the stat only waits for the helper (decision 6)

/** A distro's machine as the registry builds it (#945): the last hello's WSL version. Any other machine has no such member. */
export type VersionedMachine = Machine & { wslVersion?(): 1 | 2 | null };
export interface AgentCheck { language: Language; skipLogin: boolean }
export interface AgentRefusal { message: string; code: typeof AGENT_UNAVAILABLE | typeof AGENT_LOGGED_OUT; agent: AgentId; machine: MachineId }
/** Where a spawn runs (decisions 6 and 8): its machine and the workspace's folder there, whose stat waits for a distro's helper. */
export type RunPlace = AgentCheck & { machine: Machine; folder: string };

const onDistro = (machine: Pick<Machine, 'id'>): boolean => machine.id.startsWith(WSL_MACHINE_PREFIX);

/** The agents `machine` can run (decision 5): info().agents, and on a distro claude alone, whatever else its PATH holds. */
export function machineAgents(machine: Pick<Machine, 'id' | 'info'>): AgentAvailability[] {
  const { agents } = machine.info();
  return onDistro(machine) ? agents.map((a) => (a.agent === DISTRO_AGENT ? a : { ...a, available: false })) : agents;
}

/** What the agent check reads of the config (decision 2): a selected Claude account carries its token in the run's env, so no login check. */
export const agentCheck = (config: Pick<Config, 'accounts'>, language: Language): AgentCheck => ({ language, skipLogin: config.accounts.claude !== undefined });

/** Whether the machine's claude is logged in (decision 3), read on every call: exit 0 with loggedIn true; anything else is logged out. */
export async function loginOf(machine: Pick<Machine, 'exec'>): Promise<boolean> {
  try {
    const { stdout } = await machine.exec('claude', ['auth', 'status'], { timeout: AUTH_TIMEOUT_MS });
    const status: unknown = JSON.parse(stdout);
    return isRecord(status) && status.loggedIn === true;
  } catch {
    return false; // exit 1, output that is not its JSON, a timeout
  }
}

/** Whether gh is on the machine's PATH (decision 10): only the binary, since the Hive lends GH_TOKEN to every call on a distro. The login
 *  check's bound, so one stuck distro cannot hold GET /machines. */
export const hasGh = (machine: Pick<Machine, 'exec'>): Promise<boolean> =>
  machine.exec('gh', ['--version'], { timeout: AUTH_TIMEOUT_MS }).then(() => true, () => false);

/** The local machine as GET /machines lists it: ready, with boot's agents and no login (decision 2). */
export const localStatus = (machine: Pick<Machine, 'id' | 'info'>): MachineStatus => ({ id: machine.id, status: READY, agents: machineAgents(machine) });

// The machine's agents, claude's login beside it when it is there and no account is selected (decision 2)
async function loggedAgents(machine: Machine, skipLogin: boolean): Promise<MachineAgent[]> {
  const agents = machineAgents(machine);
  const claude = agents.find((a) => a.agent === DISTRO_AGENT && a.available);
  if (claude === undefined || skipLogin) return agents;
  const loggedIn = await loginOf(machine);
  return agents.map((a) => (a === claude ? { ...a, loggedIn } : a));
}

/** A running distro as GET /machines lists it (decisions 1 and 11): the stat starts its helper when it has none, and a machine that cannot
 *  answer is listed with its reason. The caller lists a stopped distro itself, never asking its machine. */
export async function distroStatus(machine: VersionedMachine, { skipLogin }: Pick<AgentCheck, 'skipLogin'>): Promise<MachineStatus> {
  const refused = await machineRefusal(machine, ROOT);
  const wslVersion = machine.wslVersion?.() ?? null;
  if (refused !== undefined) return { id: machine.id, status: refused.reason ?? HELPER_FAILED, wslVersion };
  const [agents, gh] = await Promise.all([loggedAgents(machine, skipLogin), hasGh(machine)]);
  return { id: machine.id, status: READY, wslVersion, agents, gh };
}

/** Why `agent` cannot run on `machine` (decisions 7 to 9), or undefined. Called after a call that waited for a distro's helper (decision 6),
 *  so info() answers. Local keeps agentRefusal's words and has no login check. On a distro only claude is ever available. */
export async function agentOnMachine(agent: AgentId, machine: Pick<Machine, 'id' | 'info' | 'exec'>, { language, skipLogin }: AgentCheck): Promise<AgentRefusal | undefined> {
  const named = { agent, machine: machine.id };
  if (!isAvailable(agent, machineAgents(machine))) {
    return { message: onDistro(machine) ? tIn(language, 'machine.agentUnavailable', named) : notOnPathRefusal(agent), code: AGENT_UNAVAILABLE, ...named };
  }
  if (!onDistro(machine) || skipLogin || (await loginOf(machine))) return undefined;
  return { message: tIn(language, 'machine.agentLoggedOut', named), code: AGENT_LOGGED_OUT, ...named };
}

/** A spawn's check (decisions 6 and 8): the stat of the workspace's folder, which waits for a distro's helper, then the agent on the machine.
 *  The refusal's words, or undefined. A folder that is only missing refuses nothing here, as machineRefusal says. */
export async function runRefusal(agent: AgentId, { machine, folder, ...check }: RunPlace): Promise<string | undefined> {
  const unavailable = await machineRefusal(machine, folder);
  return unavailable?.message ?? (await agentOnMachine(agent, machine, check))?.message;
}
