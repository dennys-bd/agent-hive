import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accessFor } from '../../src/read-model/access.js';
import type { GhRun } from '../../src/read-model/rest.js';
import type { Exec } from '../../src/types.js';
import { SOURCE } from './fixtures.js';

const NOT_MODIFIED = 'HTTP/2.0 304 Not Modified\n\r\n';
const PATH = 'repos/acme/hive/issues';
const noGh: Exec = async () => {
  throw new Error('spawn gh ENOENT');
};

test('cli: the source is gh\'s github.com login, read from its config with no request, and gh runs as is (#180)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: 'bia\n' };
  };
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const run: GhRun = async (_args, env) => {
    envs.push(env);
    return NOT_MODIFIED;
  };
  const access = await accessFor('cli', { exec, run });
  assert.equal(access?.source, SOURCE);
  assert.deepEqual(calls, [['gh', 'config', 'get', 'user', '--host', 'github.com']]);
  await access?.rest(PATH, 'W/"e"');
  assert.deepEqual(envs, [{ GH_HOST: 'github.com', GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined }],
    'gh reads as its own login: the inherited tokens are dropped and the host is github.com');
});

test('cli: gh with no login, or no gh at all, is no access (#180)', async () => {
  assert.equal(await accessFor('cli', { exec: async () => ({ stdout: '\n' }) }), undefined);
  assert.equal(await accessFor('cli', { exec: noGh }), undefined);
});

test('api: the source is the stored login, and gh gets the stored token as GH_TOKEN, never in its argv (#180)', async () => {
  const token = `test-${randomUUID()}`; // built at runtime: no token in a fixture
  const seen: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: GhRun = async (args, env) => {
    seen.push({ args, env });
    return NOT_MODIFIED;
  };
  const access = await accessFor('api', { exec: noGh, credentials: async () => ({ github: { token, login: 'bia' } }), run });
  assert.equal(access?.source, SOURCE);
  await access?.rest(PATH, 'W/"e"');
  assert.equal(seen[0]?.env?.GH_TOKEN, token);
  assert.equal(seen[0]?.env?.GH_HOST, 'github.com', 'an inherited GH_HOST never receives the token');
  assert.ok(!seen[0]?.args.some((arg) => arg.includes(token)));
});

test('api: nothing stored is no access (#180)', async () => {
  assert.equal(await accessFor('api', { exec: noGh, credentials: async () => ({}) }), undefined);
});
