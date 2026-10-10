import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installSandbox, SANDBOX_FILE, sandboxSettings } from '../../scripts/experiment/sandbox.js';
import { tempDir } from '../temp-dir.js';

const PATHS = { gitDir: '/lab/hive/.git', origin: '/lab/hive.git', state: '/home/u/.local/state/agent-hive-lab' };

test('the workers\' Bash runs sandboxed with no prompt and no way out: writes reach the clone\'s git and the local origin, reads miss the secrets and the experiment (#105)', () => {
  const { sandbox } = sandboxSettings(PATHS) as { sandbox: Record<string, unknown> & { filesystem: Record<string, string[]>; network: Record<string, unknown> } };
  assert.deepEqual([sandbox.enabled, sandbox.autoAllowBashIfSandboxed, sandbox.allowUnsandboxedCommands, sandbox.failIfUnavailable], [true, true, false, true]);
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/lab/hive/.git', '/lab/hive.git']);
  for (const path of ['~/.ssh', '~/.aws', '~/.config/gh', PATHS.state]) assert.ok(sandbox.filesystem.denyRead.includes(path), path);
  assert.deepEqual(sandbox.network.allowedDomains, ['registry.npmjs.org', 'localhost', '127.0.0.1']);
  assert.equal(sandbox.network.allowLocalBinding, true, 'the Hive\'s own tests listen on localhost ports: without it every one fails with listen EPERM');
});

test('an origin that is not a local path adds no writable path: a push there leaves the sandbox only through its network rules (#105)', () => {
  const { sandbox } = sandboxSettings({ ...PATHS, origin: 'https://example.test/repo.git' }) as { sandbox: { filesystem: { allowWrite: string[] } } };
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/lab/hive/.git']);
});

test('installSandbox writes the settings where the worktree setup copies them from, and keeps them out of git once (#105)', async (t) => {
  const root = await tempDir(t, 'sandbox-');
  await mkdir(join(root, '.git', 'info'), { recursive: true });
  await writeFile(join(root, '.git', 'info', 'exclude'), '# local\n');
  const settings = sandboxSettings({ ...PATHS, gitDir: join(root, '.git') });
  await installSandbox(root, join(root, '.git'), settings);
  await installSandbox(root, join(root, '.git'), settings);
  assert.deepEqual(JSON.parse(await readFile(join(root, SANDBOX_FILE), 'utf8')), settings);
  assert.equal(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8'), `# local\n${SANDBOX_FILE}\n`);
});

test('a run\'s plugin copy is re-allowed for reading by its exact path inside the denied state folder: the plugin skills read their conventions there (#105)', () => {
  const plugins = ['/home/u/.local/state/agent-hive-lab/homes/abc123/plugin', '/home/u/.local/state/agent-hive-lab/homes/def456/plugin'];
  const { sandbox } = sandboxSettings({ ...PATHS, plugins }) as { sandbox: { filesystem: { allowRead?: string[]; denyRead: string[] } } };
  assert.deepEqual(sandbox.filesystem.allowRead, plugins);
  assert.ok(sandbox.filesystem.denyRead.includes(PATHS.state), 'the rest of the state folder stays denied: a glob in allowRead does not work, only exact paths');
  assert.equal((sandboxSettings(PATHS) as { sandbox: { filesystem: { allowRead?: string[] } } }).sandbox.filesystem.allowRead, undefined);
});
