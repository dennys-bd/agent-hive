import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENTS } from '../src/agents.js';
import { capturedCwd, capturedReply, installShim, renderShim, shimPath, type ShimAgent } from '../src/shim.js';
import { runners } from '../src/agents/registry.js';
import { SECRET_HEADER } from '../src/secret.js';
import { AGENT_IDS } from '../src/types.js';
import { SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const run = promisify(execFile);
const RUN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
// A fake agent CLI: its HIVE_PTY_ID, its HIVE_MCP_SECRET when it has one (#932), then its argv, one per line, into $OUT
const FAKE_CLI = `#!/bin/sh
{ printf '%s\\n' "pty=$HIVE_PTY_ID"; [ -z "\${HIVE_MCP_SECRET+set}" ] || printf '%s\\n' "mcp=$HIVE_MCP_SECRET"; [ $# -eq 0 ] || printf '%s\\n' "$@"; } > "$OUT"
`;

interface Seen { url: string; secret?: string; pty?: string }
interface Hive { seen: Seen[]; forms: Record<string, string>[]; port: number }

// A Hive that answers the register with `answer` and anything else with 200, recording every request and each register's posted form (#932)
async function fakeHive(t: TestContext, answer: { status: number; body: string }): Promise<Hive> {
  const seen: Seen[] = [];
  const forms: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const header = (name: string): string | undefined => (typeof req.headers[name] === 'string' ? req.headers[name] : undefined);
      seen.push({ url: req.url ?? '', secret: header('x-hive-secret'), pty: header('x-hive-pty') });
      const isRegister = req.url?.startsWith('/hooks/terminals/') === true;
      if (isRegister) forms.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(isRegister ? answer.status : 200, { 'content-type': 'text/plain' });
      res.end(isRegister ? answer.body : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  return { seen, forms, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

// The agent's shim installed in a home of its own, the fake CLI in a dir after it on PATH, a secret file and a terminal's env
async function shimmed(t: TestContext, port: number, extraEnv: Record<string, string> = {}, agent: ShimAgent = AGENTS.claude): Promise<(...args: string[]) => Promise<string[]>> {
  const home = await tempDir(t, 'home-');
  const real = join(home, 'real');
  await mkdir(real);
  await writeFile(join(real, agent.command), FAKE_CLI);
  await chmod(join(real, agent.command), 0o755);
  await installShim(home, agent);
  const secretFile = join(home, 'hive.secret');
  await writeFile(secretFile, `${SECRET_HEADER}: ${SECRET}\n`); // the daemon's own format (daemon-files.ts)
  const out = join(home, 'out');
  // a second dir before the real one holding a link to the shim: the loop must skip it as the same file, not recurse into itself
  const linked = join(home, 'linked');
  await mkdir(linked);
  await symlink(shimPath(home, agent), join(linked, agent.command));
  const env = { PATH: `${join(home, 'bin')}:${linked}:${real}:/usr/bin:/bin`, HIVE_PTY_ID: 'T1', HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile, OUT: out, ...extraEnv };
  return async (...args) => {
    await run(shimPath(home, agent), args, { env, cwd: extraEnv.PWD });
    return (await readFile(out, 'utf8')).trimEnd().split('\n');
  };
}

test('a new conversation registers with the Hive, runs the real claude with the Hive\'s args before the user\'s and the run id as HIVE_PTY_ID, then reports its exit (#696)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n--session-id\nS1\n--settings\n/h/hooks.json` });
  const claude = await shimmed(t, hive.port);
  assert.deepEqual(await claude('fix the bug', "it's broken"), [`pty=${RUN_ID}`, '--session-id', 'S1', '--settings', '/h/hooks.json', 'fix the bug', "it's broken"]);
  assert.deepEqual(hive.seen, [
    { url: '/hooks/terminals/T1/session', secret: SECRET, pty: undefined },
    { url: '/hooks/exit', secret: SECRET, pty: RUN_ID },
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

test('capturedCwd keeps an absolute folder on one line inside the terminal\'s own, and nothing else (#932)', () => {
  assert.deepEqual(
    ['/r', '/r/src', '/r/..x', '/elsewhere', '/r/../x', 'src', '/r/a\nb', 42].map((value) => capturedCwd(value, '/r')),
    ['/r', '/r/src', '/r/..x', undefined, undefined, undefined, undefined, undefined],
  );
  assert.equal(capturedCwd('/r', undefined), undefined);
});

test('capturedReply answers the run id then one arg per line, and refuses an arg holding a newline (#696)', () => {
  assert.equal(capturedReply(RUN_ID, ['--settings', '/h/a b.json']), `${RUN_ID}\n--settings\n/h/a b.json`);
  assert.equal(capturedReply(RUN_ID, ['--x', 'two\nlines']), undefined);
  assert.equal(capturedReply(RUN_ID, ['cr\r']), undefined);
});

test('a captured session\'s argv puts the workspace\'s language-server plugin right after the Hive\'s own --plugin-dir, as ptyCommand does, and nothing without one (#803, #924)', () => {
  const base = { ptyId: 'R1', cwd: '/wt', port: 4242, withHive: true, mcpPath: '/h/prompts/R1.mcp.json', hooksPath: '/h/hooks.json', pluginDir: '/h/plugin', extraArgs: ['--model', 'opus'], session: { id: 'S1', resume: false } };
  assert.deepEqual(runners.claude.launch({ ...base, lspPluginDir: '/h/lsp/hive', protocolPath: '/h/protocol/session.md' }).flat(), [
    '--mcp-config', '/h/prompts/R1.mcp.json', '--settings', '/h/hooks.json', '--plugin-dir', '/h/plugin', '--plugin-dir', '/h/lsp/hive',
    '--append-system-prompt-file', '/h/protocol/session.md', '--model', 'opus', '--session-id', 'S1',
  ]);
  assert.deepEqual(runners.claude.launch(base).flat(), ['--mcp-config', '/h/prompts/R1.mcp.json', '--settings', '/h/hooks.json', '--plugin-dir', '/h/plugin', '--model', 'opus', '--session-id', 'S1']);
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

test('renderShim fills the command, the subcommands and the flags; installShim writes every agent\'s <home>/bin/<command> from the one template, executable (#696, #924, #932)', async (t) => {
  const agent: ShimAgent = { command: 'x', subcommands: ['a', 'b'], shimFlags: ['-q', '--q=*'] };
  assert.equal(renderShim('__HIVE_COMMAND__ "$__HIVE_COMMAND__" in __HIVE_SUBCOMMANDS__) __HIVE_FLAGS__)', agent), 'x "$x" in a|b) -q|--q=*)');
  const home = await tempDir(t, 'home-');
  for (const id of AGENT_IDS) {
    const path = await installShim(home, AGENTS[id]);
    assert.equal(path, shimPath(home, AGENTS[id]));
    assert.equal((await stat(path)).mode & 0o777, 0o755);
    assert.doesNotMatch(await readFile(path, 'utf8'), /__HIVE_[A-Z]+__/, id);
  }
  assert.equal(shimPath('/h', { command: 'other' }), join('/h', 'bin', 'other'), 'one file per agent, named after its command');
});

test('every codex subcommand, resume and fork included, and every codex passthrough flag in any position reach the real codex as typed, unregistered (#932)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n-c\nx=1` });
  const codex = await shimmed(t, hive.port, {}, AGENTS.codex);
  assert.ok(['resume', 'fork'].every((word) => AGENTS.codex.subcommands.includes(word)));
  const typed = [...AGENTS.codex.subcommands.map((word) => [word, 'x']), ...AGENTS.codex.shimFlags.map((flag) => ['a prompt', flag])];
  for (const args of typed) assert.deepEqual(await codex(...args), ['pty=T1', ...args], args.join(' '));
  assert.deepEqual(hive.seen, []);
});

test('a codex whose reply has no Hive MCP server (a local terminal) gets no MCP secret in its env (#932)', async (t) => {
  const hiveArgs = ['-c', 'projects={"/w"={trust_level="trusted"}}'];
  const hive = await fakeHive(t, { status: 200, body: [RUN_ID, ...hiveArgs].join('\n') });
  const codex = await shimmed(t, hive.port, {}, AGENTS.codex);
  assert.deepEqual(await codex(), [`pty=${RUN_ID}`, ...hiveArgs]);
});

test('a plain codex and codex "a prompt" register with agent=codex and the shim\'s folder, then run the real codex with the Hive\'s args first and the MCP secret in its env only (#932)', async (t) => {
  const hiveArgs = ['-c', 'projects={"/w"={trust_level="trusted"}}', '-c', 'mcp_servers.hive.url="http://127.0.0.1:1/mcp"', '--dangerously-bypass-hook-trust'];
  const hive = await fakeHive(t, { status: 200, body: [RUN_ID, ...hiveArgs].join('\n') });
  const work = await tempDir(t, 'work-');
  const codex = await shimmed(t, hive.port, { PWD: work }, AGENTS.codex);
  assert.deepEqual(await codex(), [`pty=${RUN_ID}`, `mcp=${SECRET}`, ...hiveArgs]);
  assert.deepEqual(await codex('a prompt'), [`pty=${RUN_ID}`, `mcp=${SECRET}`, ...hiveArgs, 'a prompt']);
  assert.deepEqual(hive.forms, [{ agent: 'codex', cwd: work }, { agent: 'codex', cwd: work }]);
  assert.deepEqual(hive.seen.map((s) => s.url), ['/hooks/terminals/T1/session', '/hooks/exit', '/hooks/terminals/T1/session', '/hooks/exit']);
});

test('the claude shim, from the same template, still passes -c and --resume through, and a plain claude registers with agent=claude and gets no MCP secret (#932)', async (t) => {
  const hive = await fakeHive(t, { status: 200, body: `${RUN_ID}\n--session-id\nS1` });
  const work = await tempDir(t, 'work-');
  const claude = await shimmed(t, hive.port, { PWD: work });
  for (const args of [['-c'], ['--resume', 'abc'], ['go', '-c']]) assert.deepEqual(await claude(...args), ['pty=T1', ...args], args.join(' '));
  assert.deepEqual(hive.forms, [], 'Claude\'s -c is continue: a session the user chose');
  assert.deepEqual(await claude(), [`pty=${RUN_ID}`, '--session-id', 'S1']);
  assert.deepEqual(hive.forms, [{ agent: 'claude', cwd: work }]);
});
