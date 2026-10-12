import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPtyHost } from '../src/pty-host.js';
import { HANDOFF_PROMPT, isStrayAlive, killStray, renderPrompt, runSession, runTmpDir, shellQuote, ptyCommand, ptyEnv, terminalEnv, verdictsLine, withHandoff, writePrompt } from '../src/spawn.js';
import { runners } from '../src/agents/registry.js';
import { launchInternalPty } from '../src/spawn-internal.js';
import { claudeLaunch, fakePtys, LAUNCH, plainArgs } from './fakes.js';
import { SECRET } from './secret-client.js';

const SECRET_FILE_PATH = '/home/agent-hive/hive.secret';
import { tempDir } from './temp-dir.js';
import { NO_PROCESS_LIST } from './process-list.js';

const item = { itemId: 'I1', id: '7', title: 'Fix "login"', body: 'line1\n$(echo pwned) `x`', url: 'https://github.com/a/b/issues/7' };

function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MODE_MASK = 0o777;
const POLL_TRIES = 100;
const POLL_MS = 10;
const STRAGGLER_MS = 200;
const STRAGGLER_WRITERS = 4;
const STRAGGLER_POLL_TRIES = 600; // the removal's retries span ~5.5 s; a loaded machine can push the good one late

// The runs' temp base for one test (#428): os.tmpdir() reads TMPDIR on every call, so every hive-runs/ this test makes lands in a dir the
// test removes. Put back after the test, as claudeConfigDir does in server.test.ts.
async function runsBase(t: TestContext): Promise<string> {
  const base = await tempDir(t, 'runs-');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = base;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  return base;
}

// Polls until `check` holds: the run's dir is removed after the exit is reported, never awaited by it.
async function eventually(check: () => boolean, maxTries = POLL_TRIES): Promise<void> {
  for (let tries = 0; tries < maxTries && !check(); tries += 1) await sleep(POLL_MS);
  assert.ok(check(), 'never happened');
}

test('renderPrompt substitutes every placeholder', () => {
  const text = renderPrompt('#{number} {title}\n{body}\n{url}', item);
  assert.equal(text, '#7 Fix "login"\nline1\n$(echo pwned) `x`\nhttps://github.com/a/b/issues/7');
});

test('renderPrompt renders {id} and {number} the same', () => {
  assert.equal(renderPrompt('{id}={number}', { ...item, id: 'T-12' }), 'T-12=T-12');
});

test('renderPrompt renders {result.<path>}: a string as is, a nested path, any other value as JSON, a missing path or result as empty (#99)', () => {
  const result = { spec: 'docs/x-design.md', pr: { number: 12, url: 'https://github.com/a/b/pull/12' }, tags: ['a', 'b'], ok: true };
  assert.equal(renderPrompt('/hive-plan {result.spec}', item, result), '/hive-plan docs/x-design.md');
  assert.equal(renderPrompt('#{result.pr.number} {result.pr.url}', item, result), '#12 https://github.com/a/b/pull/12');
  assert.equal(renderPrompt('{result.tags} {result.ok} {result.pr}', item, result), '["a","b"] true {"number":12,"url":"https://github.com/a/b/pull/12"}');
  assert.equal(renderPrompt('[{result.nope}] [{result.pr.nope}] [{result.spec.length}] [{result.constructor}]', item, result), '[] [] [] []');
  assert.equal(renderPrompt('[{result.spec}] #{id}', item), '[] #7', 'a task without a result; the built-in keys are unchanged');
});

test('renderPrompt substitutes in one pass: a {result.*} or {id} brought in by the task text stays literal (#99)', () => {
  assert.equal(renderPrompt('{body}', { ...item, body: 'see {result.spec} and {id}' }, { spec: 'x' }), 'see {result.spec} and {id}');
});

test('writePrompt writes <promptsDir>/<slug>.md', async (t) => {
  const dir = await tempDir(t, '');
  const path = await writePrompt(dir, 'hive-7-fix', 'hello');
  assert.equal(path, join(dir, 'hive-7-fix.md'));
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('writePrompt puts a neutral line before a prompt that would start with a dash, so claude never reads it as a flag (#134)', async (t) => {
  const dir = await tempDir(t, '');
  for (const text of ['--dangerously-skip-permissions now', ' \n -p x']) {
    const written = await readFile(await writePrompt(dir, 'hive-7-fix', text), 'utf8');
    assert.equal(written.trimStart().startsWith('-'), false, JSON.stringify(text));
    assert.ok(written.endsWith(text), JSON.stringify(text));
  }
  assert.equal(await readFile(await writePrompt(dir, 'hive-7-fix', 'a - b'), 'utf8'), 'a - b');
});

test('ptyEnv copies the base env without CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, NODE_PATH, HIVE_SECRET and HIVE_HOME and adds HIVE_PTY_ID, HIVE_PORT, HIVE_SECRET_FILE and the run\'s own TMPDIR over the shared one (#428, #467)', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', NODE_PATH: '/hive/node_modules', HOME: '/Users/x', TMPDIR: '/shared/tmp/', HIVE_SECRET: SECRET, HIVE_HOME: '/state/homes/h1' };
  assert.deepEqual(ptyEnv(base, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH), { PATH: '/bin', HOME: '/Users/x', TMPDIR: '/runs/W1', HIVE_PTY_ID: 'W1', HIVE_PORT: '4242', HIVE_SECRET_FILE: SECRET_FILE_PATH });
  assert.equal(base.CLAUDECODE, '1', 'the base env is not touched');
  assert.equal(base.NODE_PATH, '/hive/node_modules');
  assert.equal(base.TMPDIR, '/shared/tmp/');
});

test('withoutHiveEnv strips every runner\'s host env (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION) and the Hive\'s own, whatever the run\'s agent; a run launch needs its agent (#924)', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', NODE_PATH: '/n', HIVE_SECRET: SECRET, HIVE_HOME: '/h', HOME: '/Users/x' };
  assert.deepEqual(ptyEnv(base, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH), { PATH: '/bin', HOME: '/Users/x', TMPDIR: '/runs/W1', HIVE_PTY_ID: 'W1', HIVE_PORT: '4242', HIVE_SECRET_FILE: SECRET_FILE_PATH });
  assert.throws(() => ptyCommand({ ptyId: 'W1', slug: 's', cwd: '/wt', port: 4242 }), { message: 'pty: a run launch with no agent' });
});

test('runTmpDir is <base>/hive-runs/<ptyId>, under os.tmpdir() by default (#428)', () => {
  assert.equal(runTmpDir('W1', '/base'), join('/base', 'hive-runs', 'W1'));
  assert.equal(runTmpDir('W1'), join(tmpdir(), 'hive-runs', 'W1'));
});

test('killStray and isStrayAlive resolve false when no process matches', { skip: NO_PROCESS_LIST }, async () => {
  assert.equal(await killStray('definitely-not-running-worker-xyz'), false);
  assert.equal(await isStrayAlive('definitely-not-running-worker-xyz'), false);
});

test('shellQuote single-quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('ptyCommand runs claude interactively in the task worktree with hive env, the MCP config, hooks, the Hive plugin and the prompt file, then reports exit', () => {
  const cmd = ptyCommand({
    ...LAUNCH, cwd: '/Users/x/my repo/.hive/worktrees/hive-1-task', promptPath: '/Users/x/my repo/.hive/prompts/hive-1-task.md',
    agent: claudeLaunch({
      hooksPath: '/Users/x/my repo/.hive/hooks.json',
      pluginDir: '/Users/x/Library/agent hive/plugin', // a space: the flag is quoted like every other path
      mcpPath: '/Users/x/my repo/.hive/prompts/W1.mcp.json', model: 'sonnet', session: { id: 'S1', resume: false },
    }),
  });
  assert.equal(
    cmd,
    "cd '/Users/x/my repo/.hive/worktrees/hive-1-task' && HIVE_PTY_ID=W1 HIVE_PORT=4242 claude --mcp-config '/Users/x/my repo/.hive/prompts/W1.mcp.json' " +
      "--settings '/Users/x/my repo/.hive/hooks.json' --plugin-dir '/Users/x/Library/agent hive/plugin' '--model' 'sonnet' '--session-id' 'S1' " +
      "\"$(cat '/Users/x/my repo/.hive/prompts/hive-1-task.md')\"; " +
      "curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @\"$HIVE_SECRET_FILE\" --noproxy '*' >/dev/null",
  );
  assert.ok(!cmd.includes('--worktree'), 'the Hive made the worktree: the runner only gets a cwd');
  // --mcp-config takes several values: --settings right after it closes the list, so neither the plugin dir nor the prompt is read as a second config
});

test('ptyCommand puts the protocol file behind the agent\'s protocol flag, right after --plugin-dir and quoted; no protocolPath, a terminal or a run command get no such flag (#167)', () => {
  const cmd = ptyCommand({ ...LAUNCH, agent: claudeLaunch({ protocolPath: "/Users/x/it's hive/protocol/stage.md" }) });
  assert.ok(
    cmd.includes("--plugin-dir '/home/agent-hive/plugin' --append-system-prompt-file '/Users/x/it'\\''s hive/protocol/stage.md' '--session-id'"),
    cmd,
  );
  assert.equal(ptyCommand(LAUNCH).includes('--append-system-prompt-file'), false, 'absent: the agent is told nothing of the Hive');
  const shell = { ...LAUNCH, terminal: true as const, agent: claudeLaunch({ protocolPath: '/home/agent-hive/protocol/stage.md' }) };
  assert.equal(ptyCommand(shell).includes('--append-system-prompt-file'), false, 'a terminal runs no agent');
  assert.equal(ptyCommand({ ...shell, run: { command: 'make', env: {} } }).includes('--append-system-prompt-file'), false, 'nor does a command');
});

test('ptyCommand loads the workspace\'s language-server plugin as a second --plugin-dir right after the Hive\'s own, quoted; none without lspPluginDir, and never in a terminal (#803)', () => {
  const cmd = ptyCommand({ ...LAUNCH, agent: claudeLaunch({ lspPluginDir: "/home/agent-hive/lsp/it's hive", protocolPath: '/home/agent-hive/protocol/stage.md' }) });
  assert.ok(cmd.includes("--plugin-dir '/home/agent-hive/plugin' --plugin-dir '/home/agent-hive/lsp/it'\\''s hive' --append-system-prompt-file '/home/agent-hive/protocol/stage.md'"), cmd);
  assert.equal(ptyCommand(LAUNCH).match(/--plugin-dir/g)?.length, 1, 'a workspace with no plugin');
  assert.equal(ptyCommand({ ...LAUNCH, terminal: true, agent: claudeLaunch({ lspPluginDir: '/home/agent-hive/lsp/hive' }) }).includes('--plugin-dir'), false, 'a terminal runs no agent');
});

const words = (run: Parameters<typeof claudeLaunch>[0]): string[] => plainArgs({ agent: claudeLaunch({ session: undefined, ...run }) });

test('a run\'s plain words are the agent\'s own args, the stage model and the session flag the reducer resolved — no worktree flag (#924)', () => {
  const task = { sessionId: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b' };
  assert.deepEqual(words({ session: runSession(task.sessionId, 'new') }), ['--session-id', task.sessionId]);
  assert.deepEqual(words({ model: 'opus', session: runSession(task.sessionId, 'continue'), extraArgs: ['--permission-mode', 'acceptEdits'] }),
    ['--permission-mode', 'acceptEdits', '--model', 'opus', '--resume', task.sessionId]);
  assert.deepEqual(words({ session: runSession(undefined, 'continue') }), [], 'no id at all: claude picks its own');
});

test("a run passes modelo as typed behind the agent's model flag (#516)", () => {
  assert.deepEqual(words({ model: 'opus[1m]', extraArgs: ['--verbose'] }), ['--verbose', '--model', 'opus[1m]']);
});

test('ptyCommand quotes every arg so a model or id with a quote cannot break out of the shell string', () => {
  const cmd = ptyCommand({ ...LAUNCH, agent: claudeLaunch({ session: undefined, extraArgs: ['--model', "o'ps"] }) });
  assert.ok(cmd.includes("'--model' 'o'\\''ps'"), cmd);
});

test('ptyCommand for a terminal: cd into the worktree, the user\'s shell, then the exit trailer with the pty id; a path with a quote and a space stays one argument (#283)', () => {
  assert.equal(
    ptyCommand({ ...LAUNCH, terminal: true, cwd: "/Users/me/it's repo/.hive/worktrees/hive-1-x" }),
    `cd '/Users/me/it'\\''s repo/.hive/worktrees/hive-1-x' && "\${SHELL:-sh}"; curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`,
  );
});

test('ptyCommand for a run command: its env exported and quoted, the command through the user\'s shell, then its closing line with the exit code and the trailer; no trap and no interactive shell, so the run ends with the command; quotes in the command and in a value stay one argument each; the plain terminal\'s line is unchanged (#300, #353)', () => {
  const trailer = `curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`;
  const echo = `printf '\\033[97m> %s\\033[0m\\r\\n'`; // the command itself above its output (redesign 05)
  const closing = `hive_code=$?; printf '\\r\\n── encerrado (código %s) ──\\r\\n' "$hive_code"`;
  const exit = 'exit "$hive_code"'; // the pty's exit carries the command's code to the console (#537)
  const shell = { ...LAUNCH, terminal: true as const, cwd: '/wt' };
  assert.equal(
    ptyCommand({ ...shell, run: { command: 'pnpm run dev -- --port $PORT', env: { PORT: '5173', HOST: 'localhost' } } }),
    `cd '/wt' && export PORT='5173' && export HOST='localhost' && ${echo} 'pnpm run dev -- --port $PORT' && "\${SHELL:-sh}" -c 'pnpm run dev -- --port $PORT'; ${closing}; ${trailer}; ${exit}`,
  );
  assert.equal(ptyCommand({ ...shell, run: { command: 'make', env: {} } }), `cd '/wt' && ${echo} 'make' && "\${SHELL:-sh}" -c 'make'; ${closing}; ${trailer}; ${exit}`);
  assert.equal(
    ptyCommand({ ...shell, run: { command: `echo 'hi' && echo "$GREETING"`, env: { GREETING: "it's $(whoami)" } } }),
    `cd '/wt' && export GREETING='it'\\''s $(whoami)' && ${echo} 'echo '\\''hi'\\'' && echo "$GREETING"' && "\${SHELL:-sh}" -c 'echo '\\''hi'\\'' && echo "$GREETING"'; ${closing}; ${trailer}; ${exit}`,
  );
  assert.equal(ptyCommand(shell), `cd '/wt' && "\${SHELL:-sh}"; ${trailer}`);
});

test('ptyCommand without promptPath starts claude with no prompt argument and still ends with the exit trailer; a manual session\'s argv has no model (#164)', () => {
  const { promptPath: _none, ...manual } = LAUNCH; // a manual session has neither a prompt nor the MCP (#99)
  assert.equal(
    ptyCommand({ ...manual, agent: claudeLaunch({ mcpPath: undefined, session: { id: 'S1', resume: true } }) }),
    "cd '/repo/.hive/worktrees/hive-1-task' && HIVE_PTY_ID=W1 HIVE_PORT=4242 claude --settings '/repo/.hive/hooks.json' " +
      "--plugin-dir '/home/agent-hive/plugin' '--resume' 'S1'; " +
      "curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @\"$HIVE_SECRET_FILE\" --noproxy '*' >/dev/null",
  );
  assert.deepEqual(words({ session: runSession('S1', 'continue'), extraArgs: ['--permission-mode', 'acceptEdits'] }), ['--permission-mode', 'acceptEdits', '--resume', 'S1']);
  assert.deepEqual(words({ session: runSession('S2', 'new') }), ['--session-id', 'S2']);
});

test('launchInternalPty runs ptyCommand through /bin/sh in the pty host, in the worktree with the worker env; started resolves once the pty exists (#251)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const handle = launchInternalPty(LAUNCH, handlers().handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await handle.started;
  const [pty] = ptys;
  assert.deepEqual([pty.file, pty.args, pty.options.cwd], ['/bin/sh', ['-c', ptyCommand(LAUNCH)], LAUNCH.cwd]);
  assert.deepEqual([pty.options.env.HIVE_PTY_ID, pty.options.env.HIVE_PORT, pty.options.env.HIVE_SECRET_FILE, pty.options.env.HIVE_SECRET, pty.options.env.CLAUDECODE], ['W1', '4242', SECRET_FILE_PATH, undefined, undefined]);
  assert.ok(pty.args[1].includes('-H @"$HIVE_SECRET_FILE"'), 'curl reads the header from the file: only its path is ever in an argv (#467)');
  assert.ok(!pty.args[1].includes('$HIVE_SECRET"'), 'no shell expands the secret into curl\'s argv, which every account reads through ps');
  assert.equal(host.has('W1'), true);
});

test('launchInternalPty reports the exit once: kill resolves on the pty\'s exit, a second kill is the same kill, and a pty that exits on its own needs no kill (#251)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const h = handlers();
  const handle = launchInternalPty(LAUNCH, h.handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await handle.started;
  let killed = false;
  const kill = handle.kill().then(() => { killed = true; });
  await tick();
  assert.deepEqual([ptys[0].killed, killed, h.exits()], [1, false, 0], 'the pty has not exited yet');
  ptys[0].exit();
  await kill;
  assert.equal(h.exits(), 1);
  await handle.kill();
  assert.deepEqual([ptys[0].killed, h.exits()], [1, 1], 'the first kill is the kill');
  const natural = handlers();
  const other = launchInternalPty({ ...LAUNCH, ptyId: 'W2' }, natural.handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await other.started;
  ptys[1].exit();
  await other.kill();
  assert.deepEqual([ptys[1].killed, natural.exits()], [0, 1], 'gone already: nothing to kill');
});

test('launchInternalPty rejects started with the pty message when the pty cannot spawn, or without a host, and never reports an exit (#251)', async (t) => {
  await runsBase(t);
  const h = handlers();
  const failing = createPtyHost(() => { throw new Error('posix_spawnp failed'); });
  await assert.rejects(launchInternalPty(LAUNCH, h.handlers, { ptys: failing, secretFile: SECRET_FILE_PATH }).started, { message: 'pty: posix_spawnp failed' });
  await eventually(() => !existsSync(runTmpDir('W1'))); // made for a run that never started, and removed (#428)
  const bare = launchInternalPty(LAUNCH, h.handlers);
  await assert.rejects(bare.started, { message: 'pty: no pty host' });
  await bare.kill(); // a run that never started has nothing to kill
  assert.deepEqual([h.exits(), h.errors], [0, []]);
});

test('launchInternalPty gives the run a TMPDIR of its own: <tmpdir>/hive-runs/<ptyId>, mode 0o700, there when the pty spawns, gone with what the run wrote once it exits (#428)', async (t) => {
  const base = await runsBase(t);
  const dir = join(base, 'hive-runs', 'W1');
  const { spawnPty, ptys } = fakePtys();
  let modeAtSpawn: number | undefined;
  const host = createPtyHost((file, args, options) => {
    modeAtSpawn = statSync(dir).mode & MODE_MASK;
    return spawnPty(file, args, options);
  });
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: host, secretFile: SECRET_FILE_PATH }).started;
  assert.equal(modeAtSpawn, 0o700);
  assert.equal(ptys[0].options.env.TMPDIR, dir);
  await writeFile(join(dir, 'left-by-a-test-run.txt'), 'x');
  ptys[0].exit();
  await eventually(() => !existsSync(dir));
  assert.deepEqual([h.exits(), h.errors], [1, []]);
});

// A process of the run outliving the pty, as node flushing its compile cache does: it keeps adding files to cache/ for `ms`. A write
// into a dir already removed fails and is dropped, so the writer never brings the dir back.
async function keepWriting(cache: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  const writer = async (w: number): Promise<void> => {
    for (let n = 0; Date.now() < until; n += 1) await writeFile(join(cache, `f${w}-${n}`), 'x').catch(() => undefined);
  };
  await Promise.all(Array.from({ length: STRAGGLER_WRITERS }, (_, w) => writer(w)));
}

test('launchInternalPty still removes a TMPDIR a straggler of the run keeps writing to after the exit, with no error (#495)', async (t) => {
  const base = await runsBase(t);
  const cache = join(base, 'hive-runs', 'W1', 'node-compile-cache');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  await mkdir(cache);
  const writing = keepWriting(cache, STRAGGLER_MS);
  await sleep(POLL_MS); // the straggler is mid-write when the pty exits
  ptys[0].exit();
  await writing;
  await eventually(() => !existsSync(join(base, 'hive-runs', 'W1')), STRAGGLER_POLL_TRIES);
  assert.deepEqual([h.exits(), h.errors], [1, []]);
});

test('launchInternalPty reports a TMPDIR it cannot remove as tmp: <message> on onError, and the exit still once (#428)', async (t) => {
  const base = await runsBase(t);
  const runs = join(base, 'hive-runs');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  await chmod(runs, 0o500); // no entry of hive-runs/ can be removed now
  t.after(() => chmod(runs, 0o700)); // runs before tempDir's removal of the base
  ptys[0].exit();
  await eventually(() => h.errors.length > 0);
  assert.match(h.errors[0], /^tmp: /);
  assert.equal(existsSync(join(runs, 'W1')), true);
  assert.equal(h.exits(), 1);
});

test('launchInternalPty rejects started with pty: when the run\'s TMPDIR cannot be made, spawns no pty and reports nothing else (#428)', async (t) => {
  const base = await runsBase(t);
  await writeFile(join(base, 'hive-runs'), 'a file where the dir should go');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await assert.rejects(launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started, { message: /^pty: / });
  await tick();
  assert.deepEqual([ptys.length, h.exits(), h.errors], [0, 0, []], 'no run on the shared temp dir, and no removal of a path never made');
});

test('a copy resumes the source as a new session under the reducer\'s id, after the agent\'s own args (#587)', () => {
  const [from, id] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const copy = runners.claude.copy({ ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: '/h', pluginDir: '/p', session: { id, resume: false }, extraArgs: ['--model', 'sonnet'] }, from);
  assert.deepEqual(plainArgs({ agent: { command: 'claude', argv: copy ?? [] } }), ['--model', 'sonnet', '--resume', from, '--fork-session', '--session-id', id]);
});

test('a copy gives the fork the dialog\'s name as its Claude Code title, in the --name= form a leading - cannot turn into an option, and the command quotes it (#587)', () => {
  const [from, id] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const run = { ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: '/h', pluginDir: '/p', session: { id, resume: false }, extraArgs: [] };
  assert.deepEqual(plainArgs({ agent: { command: 'claude', argv: runners.claude.copy(run, from, "-x it's mine") ?? [] } }), ['--resume', from, '--fork-session', '--session-id', id, "--name=-x it's mine"]);
  const command = ptyCommand({ ...LAUNCH, agent: { command: 'claude', argv: runners.claude.copy(run, from, "-x it's $HOME") ?? [] } });
  assert.ok(command.includes(shellQuote("--name=-x it's $HOME")), command);
});

test('withHandoff puts the handoff in front only for a handoff stage starting a new session with a non-empty result.handoff (#692)', () => {
  const stage = { handoff: true as const };
  const result = { handoff: 'spec at docs/s.md' };
  assert.equal(withHandoff('/hive:new-plan 7', stage, result, 'new'), 'Handoff from the previous stage:\n\nspec at docs/s.md\n\n---\n\n/hive:new-plan 7');
  assert.equal(withHandoff('p', {}, result, 'new'), 'p', 'a stage without handoff');
  assert.equal(withHandoff('p', stage, result, 'continue'), 'p', 'a resumed session already read it');
  for (const empty of [undefined, {}, { handoff: '  ' }, { handoff: 3 }]) assert.equal(withHandoff('p', stage, empty, 'new'), 'p', JSON.stringify(empty));
});

test('HANDOFF_PROMPT asks the session for hive_done with its handoff (#692)', () => {
  assert.match(HANDOFF_PROMPT, /hive_done with \{ "handoff": "<text>" \}/);
});

test('a terminal\'s env names its own history file and puts the Hive\'s bin dir first on PATH, where the claude shim is (#696)', () => {
  assert.deepEqual(terminalEnv('/h', 'T1', '/usr/bin:/bin'), { HISTFILE: '/h/terminals/T1.history', PATH: '/h/bin:/usr/bin:/bin' });
  assert.equal(terminalEnv('/h', 'T1', '').PATH, '/h/bin');
});

test('a terminal\'s launch reaches the pty with its own env over the worker env, and its ring goes to its log as it ends (#696)', async (t) => {
  await runsBase(t);
  const log = join(await tempDir(t, 'ring-'), 'W1.log');
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const launch = { ...LAUNCH, terminal: true as const, env: { HISTFILE: '/h/terminals/W1.history' }, keep: { log } };
  await launchInternalPty(launch, handlers().handlers, { ptys: host, secretFile: SECRET_FILE_PATH }).started;
  const [pty] = ptys;
  assert.deepEqual([pty.options.env.HISTFILE, pty.options.env.HIVE_PTY_ID], ['/h/terminals/W1.history', 'W1']);
  pty.emit('$ ls\r\n');
  pty.exit();
  assert.equal(await readFile(log, 'utf8'), '$ ls\r\n');
});

test('launchInternalPty spawns the pty at the launch\'s size, the grid the page asked for (#808)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  await launchInternalPty({ ...LAUNCH, size: { cols: 132, rows: 41 } }, handlers().handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  assert.deepEqual([ptys[0].options.cols, ptys[0].options.rows], [132, 41]);
});

test('renderPrompt fills {verdict} and {feedback} from its vars in the same single pass, and leaves them empty without (#134)', () => {
  const item = { itemId: 'x', id: '7', title: 'T', body: '{feedback}', url: '' };
  assert.equal(renderPrompt('{verdict}|{feedback}|{body}', item, undefined, { verdict: 'boom {id}', feedback: 'fb' }), 'boom {id}|fb|{feedback}');
  assert.equal(renderPrompt('[{verdict}][{feedback}]', item), '[][]');
});

test('verdictsLine names the stage\'s verdicts and asks hive_done for one with its evidence; a stage with none adds nothing (#134)', () => {
  assert.equal(verdictsLine({ verdicts: ['ok', 'redo'] }), '\n\nThis stage ends with a verdict: call hive_done with "verdict" set to one of "ok", "redo", and the evidence behind it as "evidence".');
  assert.equal(verdictsLine({}), '');
  assert.equal(verdictsLine({ verdicts: [] }), '');
});
