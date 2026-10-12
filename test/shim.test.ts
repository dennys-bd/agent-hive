import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENTS } from '../src/agents.js';
import { capturedArgs, capturedReply, installShim, renderShim, shimPath } from '../src/shim.js';
import { tempDir } from './temp-dir.js';

const run = promisify(execFile);
const RUN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
// A fake claude: its HIVE_PTY_ID, then its argv, one per line, into $OUT
const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "pty=$HIVE_PTY_ID" "$@" > "$OUT"
`;

interface Seen { url: string; secret?: string; pty?: string }

// A Hive that answers the register with `answer` and anything else with 200, recording every request
async function fakeHive(t: TestContext, answer: { status: number; body: string }): Promise<{ seen: Seen[]; port: number }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const header = (name: string): string | undefined => (typeof req.headers[name] === 'string' ? req.headers[name] : undefined);
    seen.push({ url: req.url ?? '', secret: header('x-hive-secret'), pty: header('x-hive-pty') });
    const isRegister = req.url?.startsWith('/hooks/terminals/') === true;
    res.writeHead(isRegister ? answer.status : 200, { 'content-type': 'text/plain' });
    res.end(isRegister ? answer.body : '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  return { seen, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

// The shim installed in a home of its own, the fake claude in a dir after it on PATH, a secret file and a terminal's env
async function shimmed(t: TestContext, port: number, extraEnv: Record<string, string> = {}): Promise<(...args: string[]) => Promise<string[]>> {
  const home = await tempDir(t, 'home-');
  const real = join(home, 'real');
  await mkdir(real);
  await writeFile(join(real, 'claude'), FAKE_CLAUDE);
  await chmod(join(real, 'claude'), 0o755);
  await installShim(home, AGENTS.claude);
  const secretFile = join(home, 'hive.secret');
  await writeFile(secretFile, 'x-hive-secret: s3cret\n');
  const out = join(home, 'out');
  // a second dir before the real one holding a link to the shim: the loop must skip it as the same file, not recurse into itself
  const linked = join(home, 'linked');
  await mkdir(linked);
  await symlink(shimPath(home, AGENTS.claude), join(linked, 'claude'));
  const env = { PATH: `${join(home, 'bin')}:${linked}:${real}:/usr/bin:/bin`, HIVE_PTY_ID: 'T1', HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile, OUT: out, ...extraEnv };
  return async (...args) => {
    await run(shimPath(home, AGENTS.claude), args, { env });
    return (await readFile(out, 'utf8')).trimEnd().split('\n');
  };
}

test('a new conversation registers with the Hive, runs the real claude with the Hive\'s args before the user\'s and the run id as HIVE_PTY_ID, then reports its exit (#696)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n--session-id\nS1\n--settings\n/h/hooks.json` });
  const claude = await shimmed(t, hive.port);
  assert.deepEqual(await claude('fix the bug', "it's broken"), [`pty=${RUN_ID}`, '--session-id', 'S1', '--settings', '/h/hooks.json', 'fix the bug', "it's broken"]);
  assert.deepEqual(hive.seen, [
    { url: '/hooks/terminals/T1/session', secret: 's3cret', pty: undefined },
    { url: '/hooks/exit', secret: 's3cret', pty: RUN_ID },
  ]);
});

test('the reply is never evaluated: an arg with spaces, quotes or a command substitution reaches claude as one literal arg (#696)', async (t) => {
  const tricky = ['/h/a dir/hooks.json', "it's", '$(touch pwned)', '`id`', '"; exit 3; "'];
  const hive = await fakeHive(t, { status: 200, body: [RUN_ID, ...tricky].join('\n') });
  const claude = await shimmed(t, hive.port);
  assert.deepEqual(await claude('go'), [`pty=${RUN_ID}`, ...tricky, 'go']);
  await assert.rejects(access('pwned'), 'nothing in the reply ran');
});

test('a proxy in the env never sees the register nor the exit report: both go straight to 127.0.0.1 (#696)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n--session-id\nS1` });
  const dead = 'http://127.0.0.1:9';
  const claude = await shimmed(t, hive.port, { http_proxy: dead, HTTP_PROXY: dead, ALL_PROXY: dead, all_proxy: dead });
  assert.deepEqual(await claude('hi'), [`pty=${RUN_ID}`, '--session-id', 'S1', 'hi']);
  assert.deepEqual(hive.seen.map((s) => s.url), ['/hooks/terminals/T1/session', '/hooks/exit']);
});

test('capturedReply answers the run id then one arg per line, and refuses an arg holding a newline (#696)', () => {
  assert.equal(capturedReply(RUN_ID, ['--settings', '/h/a b.json']), `${RUN_ID}\n--settings\n/h/a b.json`);
  assert.equal(capturedReply(RUN_ID, ['--x', 'two\nlines']), undefined);
  assert.equal(capturedReply(RUN_ID, ['cr\r']), undefined);
});

test('capturedArgs puts the workspace\'s language-server plugin right after the Hive\'s own --plugin-dir, as ptyCommand does, and nothing without one (#803)', () => {
  const base = { sessionId: 'S1', mcpPath: '/h/prompts/R1.mcp.json', hooksPath: '/h/hooks.json', pluginDir: '/h/plugin', claudeArgs: ['--model', 'opus'] };
  assert.deepEqual(capturedArgs({ ...base, lspPluginDir: '/h/lsp/hive', protocolPath: '/h/protocol/session.md' }), [
    '--mcp-config', '/h/prompts/R1.mcp.json', '--settings', '/h/hooks.json', '--plugin-dir', '/h/plugin', '--plugin-dir', '/h/lsp/hive',
    '--append-system-prompt-file', '/h/protocol/session.md', '--model', 'opus', '--session-id', 'S1',
  ]);
  assert.deepEqual(capturedArgs(base), ['--mcp-config', '/h/prompts/R1.mcp.json', '--settings', '/h/hooks.json', '--plugin-dir', '/h/plugin', '--model', 'opus', '--session-id', 'S1']);
});

test('--resume, -p, --version and a subcommand pass straight through, unregistered (#696)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n--session-id\nS1` });
  const claude = await shimmed(t, hive.port);
  for (const args of [['--resume', 'abc'], ['-p', 'hi'], ['--version'], ['mcp', 'list']]) {
    assert.deepEqual(await claude(...args), ['pty=T1', ...args], args.join(' '));
  }
  assert.deepEqual(hive.seen, []);
});

test('a refused register runs the user\'s command as typed, with no exit report (#696)', async (t) => {
  const hive = await fakeHive(t, { status: 409, body: '{"error":"no"}' });
  const claude = await shimmed(t, hive.port);
  assert.deepEqual(await claude('hello'), ['pty=T1', 'hello']);
  assert.deepEqual(hive.seen.map((s) => s.url), ['/hooks/terminals/T1/session']);
});

test('renderShim writes the agent\'s subcommands as the passthrough pattern; installShim writes <home>/bin/<command> executable; shimPath follows the command (#696, #924)', async (t) => {
  assert.equal(renderShim('case "$1" in __HIVE_SUBCOMMANDS__) ;; esac', AGENTS.claude), `case "$1" in ${AGENTS.claude.subcommands.join('|')}) ;; esac`);
  const home = await tempDir(t, 'home-');
  const path = await installShim(home, AGENTS.claude);
  assert.equal(path, shimPath(home, AGENTS.claude));
  assert.equal((await stat(path)).mode & 0o777, 0o755);
  assert.equal((await readFile(path, 'utf8')).includes('__HIVE_SUBCOMMANDS__'), false);
  assert.equal(shimPath('/h', { command: 'other' }), join('/h', 'bin', 'other'), 'one file per agent, named after its command');
});
