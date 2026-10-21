import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { excludeSandbox, installSandbox, SANDBOX_DOMAINS, SANDBOX_FILE, sandboxSettings } from '../../src/benchmark/sandbox.js';
import { tempDir } from '../temp-dir.js';

const CODE = { gitDir: '/lab/hive/.git', origin: '/lab/hive.git' };
const DOCS = { gitDir: '/lab/hive/docs/.git', origin: '/lab/hive-docs.git' };
const PATHS = { repos: [CODE, DOCS], denied: ['/home/u/.local/state/agent-hive-lab'], allowedDomains: SANDBOX_DOMAINS };

test('the workers\' Bash runs sandboxed with no prompt and no way out: writes reach both clones\' git and their local origins, reads miss the secrets and the experiment (#105, #79)', () => {
  const { sandbox } = sandboxSettings(PATHS) as { sandbox: Record<string, unknown> & { filesystem: Record<string, string[]>; network: Record<string, unknown> } };
  assert.deepEqual([sandbox.enabled, sandbox.autoAllowBashIfSandboxed, sandbox.allowUnsandboxedCommands, sandbox.failIfUnavailable], [true, true, false, true]);
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/lab/hive/.git', '/lab/hive.git', '/lab/hive/docs/.git', '/lab/hive-docs.git'], 'a docs worktree\'s commits land in the docs clone\'s .git');
  for (const path of ['~/.ssh', '~/.aws', '~/.config/gh', PATHS.denied[0]]) assert.ok(sandbox.filesystem.denyRead.includes(path), path);
  assert.deepEqual(sandbox.network.allowedDomains, ['registry.npmjs.org', 'localhost', '127.0.0.1']);
  assert.equal(sandbox.network.allowLocalBinding, true, 'the Hive\'s own tests listen on localhost ports: without it every one fails with listen EPERM');
});

test('an origin that is not a local path adds no writable path: a push there leaves the sandbox only through its network rules (#105)', () => {
  const { sandbox } = sandboxSettings({ ...PATHS, repos: [{ ...CODE, origin: 'https://example.test/repo.git' }] }) as { sandbox: { filesystem: { allowWrite: string[] } } };
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/lab/hive/.git']);
});

test('installSandbox writes the settings where the worktree setup copies them from, and keeps them out of git once (#105)', async (t) => {
  const root = await tempDir(t, 'sandbox-');
  await mkdir(join(root, '.git', 'info'), { recursive: true });
  await writeFile(join(root, '.git', 'info', 'exclude'), '# local\n');
  const settings = sandboxSettings({ ...PATHS, repos: [{ ...CODE, gitDir: join(root, '.git') }] });
  await installSandbox(root, join(root, '.git'), settings);
  await installSandbox(root, join(root, '.git'), settings);
  assert.deepEqual(JSON.parse(await readFile(join(root, SANDBOX_FILE), 'utf8')), settings);
  assert.equal(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8'), `# local\n${SANDBOX_FILE}\n`);
});

test('a run\'s plugin copy is re-allowed for reading by its exact path inside the denied state folder: the plugin skills read their conventions there (#105)', () => {
  const plugins = ['/home/u/.local/state/agent-hive-lab/homes/abc123/plugin', '/home/u/.local/state/agent-hive-lab/homes/def456/plugin'];
  const { sandbox } = sandboxSettings({ ...PATHS, allowRead: plugins }) as { sandbox: { filesystem: { allowRead?: string[]; denyRead: string[] } } };
  assert.deepEqual(sandbox.filesystem.allowRead, plugins);
  assert.ok(sandbox.filesystem.denyRead.includes(PATHS.denied[0]), 'the rest of the state folder stays denied: a glob in allowRead does not work, only exact paths');
  assert.equal((sandboxSettings(PATHS) as { sandbox: { filesystem: { allowRead?: string[] } } }).sandbox.filesystem.allowRead, undefined);
});

test('the hosts and the denied folders are the caller\'s: a run passes its network row and its experiment folder (#471)', async (t) => {
  const { sandbox } = sandboxSettings({ repos: [CODE], denied: ['/hive/benchmark/e'], allowRead: ['/hive/benchmark/e/clone'], allowedDomains: ['example.org'] }) as { sandbox: { filesystem: { denyRead: string[]; allowRead: string[] }; network: { allowedDomains: string[] } } };
  assert.deepEqual(sandbox.network.allowedDomains, ['example.org']);
  assert.deepEqual(sandbox.filesystem.denyRead, ['~/.ssh', '~/.aws', '~/.config/gh', '~/.gnupg', '/hive/benchmark/e']);
  assert.deepEqual(sandbox.filesystem.allowRead, ['/hive/benchmark/e/clone']);
  const git = await tempDir(t, 'excl-');
  await excludeSandbox(git);
  await excludeSandbox(git);
  assert.equal(await readFile(join(git, 'info', 'exclude'), 'utf8'), `${SANDBOX_FILE}\n`);
});
