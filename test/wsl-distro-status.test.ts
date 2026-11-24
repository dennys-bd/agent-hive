import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_AGENTS } from '../src/agents.js';
import { type ExecOptions, type Machine, MachineError, type MachineExec } from '../src/machine.js';
import { unavailableMachine } from '../src/machines.js';
import type { AgentAvailability, Exec } from '../src/types.js';
import {
  AGENT_LOGGED_OUT, AGENT_UNAVAILABLE, AUTH_TIMEOUT_MS, type AgentCheck, agentCheck, agentOnMachine, distroStatus, hasGh, localStatus, loginOf,
  machineAgents, runRefusal,
} from '../src/wsl/distro-status.js';
import { fakeMachine, fakeWsl } from './fake-machine.js';

const EN: AgentCheck = { language: 'en', skipLogin: false };
const ON_DISTRO: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: false }, { agent: 'copilot', available: false }];
const LOGGED_OUT = 'agent claude is not logged in on wsl:X: run claude inside the distro and log in';
const FOLDER = '/home/u/site'; // missing on every lane: a stat that fails only as missing refuses nothing

type Auth = 'in' | 'out' | 'bad';
// wsl:X with every agent on its PATH: claude auth status answers as `auth` says (out: exit 1 with its JSON, as the spike measured), gh --version
// as `isGh` says, anything else with nothing. `calls`: every file it ran
function distro(auth: Auth, isGh = true, calls: string[] = []): Machine {
  const exec: Exec = async (file) => {
    calls.push(file);
    if (file === 'gh' && !isGh) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    if (file !== 'claude') return { stdout: '' };
    if (auth === 'in') return { stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' };
    if (auth === 'bad') return { stdout: 'not json' };
    throw Object.assign(new Error('Command failed: claude auth status'), { code: 1, stdout: '{"loggedIn": false}' });
  };
  return fakeWsl('X', { agents: ALL_AGENTS, exec });
}

// An exec that keeps each call's options and answers as `answer` does
const recording = (answer: MachineExec, seen: (ExecOptions | undefined)[]): Pick<Machine, 'exec'> => ({
  exec: (file, args, opts) => {
    seen.push(opts);
    return answer(file, args, opts);
  },
});

test('machineAgents: a distro runs claude only, whatever its PATH holds; local\'s list is its info().agents unchanged (#946)', () => {
  assert.deepEqual(machineAgents(fakeWsl('X', { agents: ALL_AGENTS })), ON_DISTRO);
  const agents: AgentAvailability[] = [{ agent: 'claude', available: false }, { agent: 'codex', available: true }];
  assert.deepEqual(machineAgents(fakeMachine({ agents })), agents);
  assert.deepEqual(localStatus(fakeMachine({ agents })), { id: 'local', status: 'ready', agents });
});

test('loginOf: exit 0 with loggedIn true is logged in; exit 1, output that is not its JSON, loggedIn false and a timeout are logged out; the call carries AUTH_TIMEOUT_MS (#946)', async () => {
  assert.equal(await loginOf(distro('in')), true);
  assert.equal(await loginOf(distro('out')), false);
  assert.equal(await loginOf(distro('bad')), false);
  assert.equal(await loginOf({ exec: async () => ({ stdout: '{"loggedIn": false}' }) }), false, 'exit 0 that says logged out');
  const seen: (ExecOptions | undefined)[] = [];
  const timedOut = recording(async () => { throw new MachineError('claude auth status timed out', { killed: true }); }, seen);
  assert.equal(await loginOf(timedOut), false);
  assert.deepEqual(seen, [{ timeout: AUTH_TIMEOUT_MS }]);
});

test('hasGh is whether gh --version exits 0 (#946)', async () => {
  assert.equal(await hasGh(distro('in')), true);
  assert.equal(await hasGh(distro('in', false)), false);
});

test('agentOnMachine on a distro: codex is agent_unavailable though its PATH has it, a logged-out claude agent_logged_out, each naming the agent and the machine; a logged-in claude runs (#946)', async () => {
  assert.deepEqual(await agentOnMachine('codex', distro('in'), EN), { message: 'agent codex is not available on wsl:X', code: AGENT_UNAVAILABLE, agent: 'codex', machine: 'wsl:X' });
  assert.deepEqual(await agentOnMachine('claude', distro('out'), EN), { message: LOGGED_OUT, code: AGENT_LOGGED_OUT, agent: 'claude', machine: 'wsl:X' });
  assert.equal((await agentOnMachine('claude', distro('out'), { ...EN, language: 'pt' }))?.message, 'o agente claude não está logado em wsl:X: rode claude dentro da distro e faça login');
  assert.equal(await agentOnMachine('claude', distro('in'), EN), undefined);
});

test('agentOnMachine asks no login when a Claude account is selected, nor on local, where a missing agent keeps the not-on-PATH words (#946)', async () => {
  const calls: string[] = [];
  assert.equal(await agentOnMachine('claude', distro('out', true, calls), agentCheck({ accounts: { claude: 'work' } }, 'en')), undefined);
  assert.deepEqual(calls, [], 'no claude auth status ran');
  const onHost: string[] = [];
  const local = fakeMachine({ agents: [{ agent: 'claude', available: false }, { agent: 'codex', available: true }], exec: async (file) => { onHost.push(file); return { stdout: '' }; } });
  assert.deepEqual(await agentOnMachine('claude', local, EN), { message: 'agent claude is not on PATH: install it, then restart the Hive', code: AGENT_UNAVAILABLE, agent: 'claude', machine: 'local' });
  assert.equal(await agentOnMachine('codex', local, EN), undefined);
  assert.deepEqual(onHost, [], 'local has no login check');
  assert.deepEqual(agentCheck({ accounts: {} }, 'pt'), { language: 'pt', skipLogin: false });
});

test('distroStatus: a ready distro lists its WSL version, its agents with claude\'s login, and gh; one that cannot answer lists its reason and no agents (#946)', async () => {
  const ready = { ...distro('in'), wslVersion: () => 2 as const };
  assert.deepEqual(await distroStatus(ready, { skipLogin: false }), {
    id: 'wsl:X', status: 'ready', wslVersion: 2, agents: [{ agent: 'claude', available: true, loggedIn: true }, ON_DISTRO[1], ON_DISTRO[2]], gh: true,
  });
  assert.deepEqual(await distroStatus(unavailableMachine('wsl:B', 'node_missing'), { skipLogin: false }), { id: 'wsl:B', status: 'node_missing', wslVersion: null });
});

test('distroStatus with a Claude account selected lists claude with no login and never runs claude auth status (#946)', async () => {
  const calls: string[] = [];
  const status = await distroStatus(distro('out', false, calls), { skipLogin: true });
  assert.deepEqual([status.status, status.agents, status.gh, status.wslVersion], ['ready', ON_DISTRO, false, null]);
  assert.ok(!calls.includes('claude'), calls.join(','));
});

test('runRefusal: an unavailable machine refuses with its own words before any agent check; a reachable one with its agent check (#946)', async () => {
  assert.equal(await runRefusal('claude', { machine: unavailableMachine('wsl:B', 'node_missing'), folder: FOLDER, ...EN }), 'machine wsl:B is unavailable: node_missing');
  assert.equal(await runRefusal('codex', { machine: distro('in'), folder: FOLDER, ...EN }), 'agent codex is not available on wsl:X');
  assert.equal(await runRefusal('claude', { machine: distro('in'), folder: FOLDER, ...EN }), undefined);
});
