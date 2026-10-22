import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv, cliEnv, createGhToken, hostsPath, loginFromHosts, NO_GH_TOKEN_MESSAGE } from '../src/github-token.js';
import type { Exec } from '../src/types.js';

const TOKEN_RUN = ['gh', 'auth', 'token', '--hostname', 'github.com'];
// gh's own layout: a users map of every login beside the active one's user line. No oauth_token line: nothing secret-looking here
const HOSTS = ['github.com:', '    users:', '        bia:', '        caio:', '    git_protocol: https', '    user: bia', ''].join('\n');

interface HostsFile { text: string; mtime: number }

/** A holder over a fake hosts.yml (mutable, so a test can rewrite it) and a counting gh. */
function harness(file: HostsFile, answer: Exec | undefined = undefined) {
  const token = `test-${randomUUID()}`; // built at runtime: no token in a fixture
  const runs: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const reads: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    runs.push({ args: [cmd, ...args], env: opts?.env });
    return answer ? answer(cmd, args, opts) : { stdout: `${token}\n` };
  };
  const ghToken = createGhToken({
    exec, env: { GH_CONFIG_DIR: '/cfg/gh', GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited', PATH: '/bin' },
    stat: async () => ({ mtimeMs: file.mtime }),
    readFile: async (path) => {
      reads.push(path);
      return file.text;
    },
  });
  return { ghToken, runs, reads, token };
}

test('loginFromHosts reads user: of the github.com block, never a name of the users map nor another host (#503)', () => {
  assert.equal(loginFromHosts(HOSTS), 'bia');
  assert.equal(loginFromHosts('ghe.example.com:\n    user: caio\ngithub.com:\n    user: bia\n'), 'bia');
  assert.equal(loginFromHosts('github.com:\n    user: bia\nghe.example.com:\n    user: caio\n'), 'bia');
  assert.equal(loginFromHosts('ghe.example.com:\n    user: caio\n'), '', 'no github.com block');
  assert.equal(loginFromHosts('github.com:\n    users:\n        bia:\n    git_protocol: https\n'), '', 'no user: line');
  assert.equal(loginFromHosts('github.com:\n    users:\n        user:\n'), '', 'a login named user in the map is no user: line');
  assert.equal(loginFromHosts(''), '');
});

test('hosts.yml is under GH_CONFIG_DIR, else XDG_CONFIG_HOME/gh, else ~/.config/gh (#503)', () => {
  assert.equal(hostsPath({ GH_CONFIG_DIR: '/cfg/own', XDG_CONFIG_HOME: '/cfg/xdg' }), join('/cfg/own', 'hosts.yml'));
  assert.equal(hostsPath({ XDG_CONFIG_HOME: '/cfg/xdg' }), join('/cfg/xdg', 'gh', 'hosts.yml'));
  assert.equal(hostsPath({ GH_CONFIG_DIR: '', XDG_CONFIG_HOME: '' }), join(homedir(), '.config', 'gh', 'hosts.yml'));
});

test('login() re-reads hosts.yml only when its mtime changes, and a change drops the held token (#503)', async () => {
  const file = { text: HOSTS, mtime: 1 };
  const { ghToken, runs, reads } = harness(file);
  assert.deepEqual(await Promise.all([ghToken.login(), ghToken.login()]), ['bia', 'bia']);
  assert.equal(await ghToken.login(), 'bia');
  assert.deepEqual(reads, [join('/cfg/gh', 'hosts.yml')], 'one read while the mtime holds');
  await ghToken.token();
  file.text = HOSTS.replace('user: bia', 'user: caio');
  file.mtime = 2;
  assert.equal(await ghToken.login(), 'caio');
  await ghToken.token();
  assert.equal(runs.length, 2, 'gh auth switch rewrote the file: the next request reads the token again');
});

test('no hosts.yml, or one that cannot be read, is no login (#503)', async () => {
  const missing = createGhToken({ exec: async () => ({ stdout: '' }), env: {}, stat: async () => { throw new Error('ENOENT'); }, readFile: async () => '' });
  assert.equal(await missing.login(), '');
  const unreadable = createGhToken({ exec: async () => ({ stdout: '' }), env: {}, stat: async () => ({ mtimeMs: 1 }), readFile: async () => { throw new Error('EACCES'); } });
  assert.equal(await unreadable.login(), '');
});

test('token() runs gh auth token once until invalidated, with no inherited token in its env (#503)', async () => {
  const { ghToken, runs, token } = harness({ text: HOSTS, mtime: 1 });
  assert.deepEqual(await Promise.all([ghToken.token(), ghToken.token()]), [token, token]);
  assert.equal(await ghToken.token(), token);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.args, TOKEN_RUN);
  const env = runs[0]?.env ?? {};
  assert.ok(!('GH_TOKEN' in env) && !('GITHUB_TOKEN' in env), 'an inherited token never answers for another account');
  assert.deepEqual([env.GH_HOST, env.PATH], ['github.com', '/bin']);
  ghToken.invalidate();
  await ghToken.token();
  assert.equal(runs.length, 2);
});

test('an empty answer or a failed gh rejects with the instruction alone, and a failure is not held (#503)', async () => {
  const secret = `test-${randomUUID()}`;
  const empty = harness({ text: HOSTS, mtime: 1 }, async () => ({ stdout: '\n' }));
  await assert.rejects(empty.ghToken.token(), { message: NO_GH_TOKEN_MESSAGE });
  const failed = harness({ text: HOSTS, mtime: 1 }, async () => { throw new Error(`Command failed: ${secret}`); });
  const err = await failed.ghToken.token().then(() => undefined, (e: Error) => e);
  assert.equal(err?.message, NO_GH_TOKEN_MESSAGE);
  assert.ok(!err?.message.includes(secret));
  await failed.ghToken.token().catch(() => undefined);
  assert.equal(failed.runs.length, 2, 'the next request asks gh again');
});

test('childEnv lays env over the parent\'s and removes a key set to undefined; cliEnv drops every inherited token (#180, #503)', () => {
  assert.deepEqual(childEnv({ A: '1', GH_TOKEN: 'x', GH_HOST: 'ghe.example.com' }, { GH_TOKEN: undefined, GH_HOST: 'github.com' }), { A: '1', GH_HOST: 'github.com' });
  assert.deepEqual(cliEnv(), { GH_HOST: 'github.com', GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined });
});
