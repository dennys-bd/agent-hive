import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ALL_AGENTS } from '../src/agents.js';
import { createMachines, unavailableMachine } from '../src/machines.js';
import { type MachineRouteDeps, registerMachineRoutes } from '../src/server-machines.js';
import type { AgentAvailability, Exec, MachineStatus } from '../src/types.js';
import type { VersionedMachine } from '../src/wsl/distro-status.js';
import type { WslDeps } from '../src/wsl/wsl-exe.js';
import { FAKE_WSL, runBuffer } from './fake-distro.js';
import { fakeMachine, fakeWsl } from './fake-machine.js';

const LOCAL_AGENTS: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }, { agent: 'copilot', available: false }];
const THREE = { FAKE_WSL_DISTROS: 'A,B,C', FAKE_WSL_RUNNING: 'A,B' }; // C is installed and stopped

const wslWith = (env: NodeJS.ProcessEnv, command: readonly string[] = [process.execPath, FAKE_WSL]): WslDeps => ({ command, run: runBuffer, env: { ...process.env, ...env } });

// The registry on win32 (every lane runs it): A is a ready distro whose claude is logged in, any other a distro whose node is missing.
// `asked`: every distro whose machine was built, which is the only way a call could reach it
function registry(asked: string[], calls: string[] = []) {
  const exec: Exec = async (file) => {
    calls.push(file);
    return { stdout: file === 'claude' ? '{"loggedIn": true}' : '' };
  };
  const ready: VersionedMachine = { ...fakeWsl('A', { agents: ALL_AGENTS, exec }), wslVersion: () => 2 };
  return createMachines({
    local: fakeMachine({ agents: LOCAL_AGENTS }), platform: 'win32',
    wsl: (distro) => {
      asked.push(distro);
      return distro === 'A' ? ready : unavailableMachine(`wsl:${distro}`, 'node_missing');
    },
  });
}

async function listed(t: TestContext, deps: MachineRouteDeps): Promise<MachineStatus[]> {
  const app = express();
  registerMachineRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/machines`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { machines: MachineStatus[] }).machines;
}

const LOCAL: MachineStatus = { id: 'local', status: 'ready', agents: LOCAL_AGENTS };

test('GET /machines off win32 answers local alone and runs no wsl.exe (#946)', async (t) => {
  const asked: string[] = [];
  const deps = { machines: registry(asked), platform: 'darwin' as const, wsl: wslWith(THREE, ['/no/such/wsl.exe']), accounts: () => undefined };
  assert.deepEqual(await listed(t, deps), [LOCAL]);
  assert.deepEqual(asked, []);
});

test('GET /machines on win32 with a wsl.exe that fails answers local alone (#946)', async (t) => {
  const asked: string[] = [];
  assert.deepEqual(await listed(t, { machines: registry(asked), platform: 'win32', wsl: wslWith(THREE, ['/no/such/wsl.exe']), accounts: () => undefined }), [LOCAL]);
  assert.deepEqual(asked, []);
});

test('GET /machines lists local, then each distro in wsl.exe order: a ready one with its version, claude logged in and gh, one with node missing, a stopped one never asked (#946)', async (t) => {
  const asked: string[] = [];
  assert.deepEqual(await listed(t, { machines: registry(asked), platform: 'win32', wsl: wslWith(THREE), accounts: () => ({}) }), [
    LOCAL,
    {
      id: 'wsl:A', status: 'ready', wslVersion: 2, gh: true,
      agents: [{ agent: 'claude', available: true, loggedIn: true }, { agent: 'codex', available: false }, { agent: 'copilot', available: false }],
    },
    { id: 'wsl:B', status: 'node_missing', wslVersion: null },
    { id: 'wsl:C', status: 'stopped' },
  ]);
  assert.deepEqual(asked, ['A', 'B'], 'the stopped distro\'s machine was never built, so never asked');
});

test('GET /machines with a Claude account selected lists a distro\'s claude with no login and runs no claude auth status (#946)', async (t) => {
  const calls: string[] = [];
  const machines = registry([], calls);
  const [, a] = await listed(t, { machines, platform: 'win32', wsl: wslWith({ FAKE_WSL_DISTROS: 'A' }), accounts: () => ({ claude: 'work' }) });
  assert.deepEqual(a?.agents?.[0], { agent: 'claude', available: true });
  assert.ok(!calls.includes('claude'), calls.join(','));
});
