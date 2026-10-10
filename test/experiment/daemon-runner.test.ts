import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemon, stopRunDaemon } from '../../scripts/experiment/daemon-runner.js';
import { tempDir } from '../temp-dir.js';
import { fakeChild } from './fixtures.js';

const sleep = async (): Promise<void> => undefined;

test('bootDaemon starts node on run.js with HIVE_HOME and waits until that home answers (#105)', async (t) => {
  const home = await tempDir(t, 'boot-');
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const { child } = fakeChild();
  let probes = 0;
  const daemon = await bootDaemon(home, '/build/dist/src/run.js', {
    spawn: (file, args, { env }) => { spawned.push({ file, args, env }); return child; },
    address: async () => { probes += 1; return probes < 3 ? undefined : { port: 4321, secret: 's'.repeat(64) }; },
    sleep,
  });
  assert.equal(daemon.address.port, 4321);
  assert.deepEqual([spawned[0].file, spawned[0].args, spawned[0].env.HIVE_HOME], [process.execPath, ['/build/dist/src/run.js'], home]);
  assert.equal(probes, 3);
  assert.ok(existsSync(join(home, 'daemon.out')));
});

test('a run daemon gets the clean user env; an evaluated daemon, the worker-built run.js, gets only the toolchain env and its home (#105)', async (t) => {
  const home = await tempDir(t, 'boot-');
  const baseEnv = { PATH: '/bin', HOME: '/h', TERM: 'xterm', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', CLAUDECODE: '1', HIVE_HOME: '/elsewhere' };
  const envs: NodeJS.ProcessEnv[] = [];
  const deps = { spawn: (_file: string, _args: string[], { env }: { env: NodeJS.ProcessEnv }) => { envs.push(env); return fakeChild().child; }, address: async () => ({ port: 1, secret: 'x' }), sleep, baseEnv };
  await bootDaemon(home, 'run.js', deps);
  await bootDaemon(home, 'run.js', { ...deps, isWorkerCode: true });
  assert.deepEqual(envs[0], { PATH: '/bin', HOME: '/h', TERM: 'xterm', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', HIVE_HOME: home }, 'the run daemon spawns claude workers: they need the user\'s login');
  assert.deepEqual(envs[1], { PATH: '/bin', HOME: '/h', TERM: 'xterm', HIVE_HOME: home });
});

test('bootDaemon fails naming daemon.out when the child exits first, and kills a child that never answers (#105)', async (t) => {
  const home = await tempDir(t, 'boot-');
  const exited = fakeChild(1);
  await assert.rejects(bootDaemon(home, 'run.js', { spawn: () => exited.child, address: async () => undefined, sleep }), /exited with 1 \(see .*daemon\.out\)/);
  const silent = fakeChild();
  await assert.rejects(bootDaemon(home, 'run.js', { spawn: () => silent.child, address: async () => undefined, sleep, waitMs: 2000 }), /did not answer in 2 s/);
  assert.deepEqual(silent.kills, ['SIGTERM']);
});

test('stopRunDaemon stops through POST /stop and falls back to SIGTERM (#105)', async () => {
  const stopped: string[] = [];
  const ok = fakeChild();
  await stopRunDaemon({ home: '/h', address: { port: 1, secret: 'x' }, child: ok.child }, { stop: async (home) => { stopped.push(home); return true; } });
  assert.deepEqual([stopped, ok.kills], [['/h'], []]);
  const refused = fakeChild();
  await stopRunDaemon({ home: '/h', address: { port: 1, secret: 'x' }, child: refused.child }, { stop: async () => { throw new Error('HTTP 500'); } });
  assert.deepEqual(refused.kills, ['SIGTERM']);
});
