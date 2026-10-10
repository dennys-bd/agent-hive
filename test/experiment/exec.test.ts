import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { buildEnv, cleanEnv, execRun, type Run, serialGit } from '../../scripts/experiment/exec.js';
import { tempDir } from '../temp-dir.js';

test('cleanEnv drops what would stop or misroute a nested claude or test runner and keeps the rest (#105)', () => {
  assert.deepEqual(cleanEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', NODE_TEST_CONTEXT: 'child', HIVE_HOME: '/h' }, { HIVE_HOME: '/run/home' }), { PATH: '/bin', HIVE_HOME: '/run/home' });
});

test('execRun runs argv in the given cwd and answers its stdout (#105)', async (t) => {
  const dir = await tempDir(t, 'exec-');
  const { stdout } = await execRun(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
  assert.equal(stdout, await realpath(dir));
});

test('serialGit runs the harness git calls one at a time across the runs of a pair, lets other commands through, and survives a failure (#105)', async () => {
  const log: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const run: Run = async (file, args) => {
    log.push(`start ${file} ${args[0]}`);
    if (args[0] === 'first') await gate;
    log.push(`end ${file} ${args[0]}`);
    return { stdout: '' };
  };
  const serial = serialGit(run);
  const all = Promise.all([serial('git', ['first']), serial('git', ['second']), serial('pnpm', ['build'])]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['start pnpm build', 'end pnpm build', 'start git first'], 'the second git call waits for the first; pnpm does not');
  open();
  await all;
  assert.deepEqual(log.slice(3), ['end git first', 'start git second', 'end git second']);
  let calls = 0;
  const flaky = serialGit(async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { stdout: 'ok' };
  });
  await assert.rejects(flaky('git', ['a']), /boom/);
  assert.equal((await flaky('git', ['b'])).stdout, 'ok', 'a failed call does not jam the queue');
});

test('buildEnv keeps the toolchain variables and drops everything else (#105)', () => {
  assert.deepEqual(buildEnv({ PATH: '/bin', HOME: '/h', PNPM_HOME: '/p', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' }), { PATH: '/bin', HOME: '/h', PNPM_HOME: '/p' });
  const toolchain = { TERM: 'xterm', CI: '1', LOGNAME: 'u', HTTPS_PROXY: 'p', HTTP_PROXY: 'p', NO_PROXY: 'n', NODE_EXTRA_CA_CERTS: '/ca.pem', PLAYWRIGHT_BROWSERS_PATH: '/pw', COREPACK_HOME: '/c' };
  assert.deepEqual(buildEnv({ ...toolchain, CLAUDE_CODE_OAUTH_TOKEN: 'z', HIVE_HOME: '/other' }), toolchain);
});
