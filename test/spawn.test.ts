import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { posixShell } from '../src/posix-shell.js';
import { HANDOFF_PROMPT, PWSH_LOADER, renderPrompt, runSession, runTmpDir, ptyCommand, ptyEnv, terminalEnv, verdictsLine, windowsShell, withHandoff, writePrompt } from '../src/spawn.js';
import { runners } from '../src/agents/registry.js';
import { shellQuote } from '../src/shell-init.js';
import { claudeLaunch, LAUNCH, plainArgs } from './fakes.js';
import { SECRET } from './secret-client.js';

const SECRET_FILE_PATH = '/home/agent-hive/hive.secret';
import { tempDir } from './temp-dir.js';

const item = { itemId: 'I1', id: '7', title: 'Fix "login"', body: 'line1\n$(echo pwned) `x`', url: 'https://github.com/a/b/issues/7' };


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
  assert.deepEqual(ptyEnv(base, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH, 'darwin'), { PATH: '/bin', HOME: '/Users/x', TMPDIR: '/runs/W1', HIVE_PTY_ID: 'W1', HIVE_PORT: '4242', HIVE_SECRET_FILE: SECRET_FILE_PATH });
  assert.equal(base.CLAUDECODE, '1', 'the base env is not touched');
  assert.equal(base.NODE_PATH, '/hive/node_modules');
  assert.equal(base.TMPDIR, '/shared/tmp/');
});

test('ptyEnv on win32 points TEMP and TMP at the run\'s own dir beside TMPDIR, where Windows tools and os.tmpdir() look; on darwin and linux TEMP and TMP stay the base env\'s (#428, #644)', () => {
  const base = { PATH: '/bin', TEMP: '/shared/temp', TMP: '/shared/tmp' };
  const dir = 'C:\\t\\hive-runs\\W1';
  const win = ptyEnv(base, 'W1', 4242, dir, SECRET_FILE_PATH, 'win32');
  assert.deepEqual([win.TMPDIR, win.TEMP, win.TMP], [dir, dir, dir]);
  for (const platform of ['darwin', 'linux'] as const) {
    const env = ptyEnv(base, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH, platform);
    assert.deepEqual([env.TMPDIR, env.TEMP, env.TMP], ['/runs/W1', '/shared/temp', '/shared/tmp'], platform);
    const bare = ptyEnv({ PATH: '/bin' }, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH, platform);
    assert.deepEqual(['TEMP' in bare, 'TMP' in bare], [false, false], platform);
  }
});

test('withoutHiveEnv strips every runner\'s host env (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION) and the Hive\'s own, whatever the run\'s agent; a run launch needs its agent (#924, #333)', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', NODE_PATH: '/n', HIVE_SECRET: SECRET, HIVE_MCP_SECRET: SECRET, HIVE_MCP_TOKEN_0: 'Bearer t0k', HIVE_MCP_TOKEN_12: 'x', HIVE_HOME: '/h', HIVE_PWSH: 'C:\\x\\pwsh.exe', HOME: '/Users/x' };
  assert.deepEqual(ptyEnv(base, 'W1', 4242, '/runs/W1', SECRET_FILE_PATH, 'darwin'), { PATH: '/bin', HOME: '/Users/x', TMPDIR: '/runs/W1', HIVE_PTY_ID: 'W1', HIVE_PORT: '4242', HIVE_SECRET_FILE: SECRET_FILE_PATH });
  assert.throws(() => ptyCommand({ ptyId: 'W1', slug: 's', cwd: '/wt', port: 4242 }), { message: 'pty: a run launch with no agent' });
});

test('runTmpDir is <base>/hive-runs/<ptyId>, under os.tmpdir() by default (#428)', () => {
  assert.equal(runTmpDir('W1', '/base'), join('/base', 'hive-runs', 'W1'));
  assert.equal(runTmpDir('W1'), join(tmpdir(), 'hive-runs', 'W1'));
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
    "cd '/Users/x/my repo/.hive/worktrees/hive-1-task' && HIVE_PTY_ID=W1 HIVE_PORT=4242 'claude' --mcp-config '/Users/x/my repo/.hive/prompts/W1.mcp.json' " +
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

const TERMINAL_SHELL = `{ if [ -n "\${HIVE_PWSH:-}" ]; then case "$(export -p)" in *'export SHELL='*|*'declare -x SHELL='*) hive_sh=\${SHELL##*[!A-Za-z0-9._-]} ;; *) hive_sh= ;; esac; else hive_sh=\${SHELL##*[!A-Za-z0-9._-]}; fi; hive_sh=\${hive_sh%.exe}; case "\${HIVE_SHELL_DIR:+$hive_sh}" in zsh) HIVE_USER_ZDOTDIR="\${ZDOTDIR-}" ZDOTDIR="$HIVE_SHELL_DIR/zsh" "$SHELL" ;; bash) "$SHELL" --rcfile "$HIVE_SHELL_DIR/bash/rc" ;; fish) "$SHELL" -C 'source "$HIVE_SHELL_DIR/fish/init.fish"' ;; *) if [ -n "\${HIVE_PWSH:-}" ]; then "$HIVE_PWSH" -NoLogo -NoProfile -NoExit -Command '${PWSH_LOADER}'; else "\${SHELL:-sh}"; fi ;; esac; }`; // #259, #645
test('ptyCommand for a terminal: cd into the worktree, the user\'s shell, then the exit trailer with the pty id; a path with a quote and a space stays one argument (#283)', () => {
  assert.equal(
    ptyCommand({ ...LAUNCH, terminal: true, cwd: "/Users/me/it's repo/.hive/worktrees/hive-1-x" }),
    `cd '/Users/me/it'\\''s repo/.hive/worktrees/hive-1-x' && ${TERMINAL_SHELL}; curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`,
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
  assert.equal(ptyCommand(shell), `cd '/wt' && ${TERMINAL_SHELL}; ${trailer}`);
});

test('ptyCommand without promptPath starts claude with no prompt argument and still ends with the exit trailer; a manual session\'s argv has no model (#164)', () => {
  const { promptPath: _none, ...manual } = LAUNCH; // a manual session has neither a prompt nor the MCP (#99)
  assert.equal(
    ptyCommand({ ...manual, agent: claudeLaunch({ mcpPath: undefined, session: { id: 'S1', resume: true } }) }),
    "cd '/repo/.hive/worktrees/hive-1-task' && HIVE_PTY_ID=W1 HIVE_PORT=4242 'claude' --settings '/repo/.hive/hooks.json' " +
      "--plugin-dir '/home/agent-hive/plugin' '--resume' 'S1'; " +
      "curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @\"$HIVE_SECRET_FILE\" --noproxy '*' >/dev/null",
  );
  assert.deepEqual(words({ session: runSession('S1', 'continue'), extraArgs: ['--permission-mode', 'acceptEdits'] }), ['--permission-mode', 'acceptEdits', '--resume', 'S1']);
  assert.deepEqual(words({ session: runSession('S2', 'new') }), ['--session-id', 'S2']);
});


test('a copy resumes the source as a new session under the reducer\'s id, after the agent\'s own args (#587)', () => {
  const [from, id] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const copy = runners.claude.copy({ ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: '/h', pluginDir: '/p', session: { id, resume: false }, extraArgs: ['--model', 'sonnet'], external: [] }, from);
  assert.deepEqual(plainArgs({ agent: { command: 'claude', argv: copy ?? [] } }), ['--model', 'sonnet', '--resume', from, '--fork-session', '--session-id', id]);
});

test('a copy gives the fork the dialog\'s name as its Claude Code title, in the --name= form a leading - cannot turn into an option, and the command quotes it (#587)', () => {
  const [from, id] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const run = { ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: '/h', pluginDir: '/p', session: { id, resume: false }, extraArgs: [], external: [] };
  assert.deepEqual(plainArgs({ agent: { command: 'claude', argv: runners.claude.copy(run, from, "-x it's mine") ?? [] } }), ['--resume', from, '--fork-session', '--session-id', id, "--name=-x it's mine"]);
  const command = ptyCommand({ ...LAUNCH, agent: { command: 'claude', argv: runners.claude.copy(run, from, "-x it's $HOME") ?? [] } });
  assert.ok(command.includes(shellQuote("--name=-x it's $HOME")), command);
});

test('withHandoff puts the handoff in front only for a handoff stage starting a new session with a non-empty result.handoff (#692)', () => {
  const stage = { handoff: true as const };
  const result = { handoff: 'spec at docs/s.md' };
  assert.equal(withHandoff('/hive:new-plan 7', stage, result, 'new'), '/hive:new-plan 7\n\nHandoff from the previous stage:\n\nspec at docs/s.md', '#710: a slash command stays first, or it never runs');
  assert.equal(withHandoff('/build {url}\nthen push', stage, result, 'new'), '/build {url}\n\nHandoff from the previous stage:\n\nspec at docs/s.md\n\n---\n\nthen push');
  assert.equal(withHandoff('p', stage, result, 'new'), 'Handoff from the previous stage:\n\nspec at docs/s.md\n\n---\n\np');
  assert.equal(withHandoff('p', {}, result, 'new'), 'p', 'a stage without handoff');
  assert.equal(withHandoff('p', stage, result, 'continue'), 'p', 'a resumed session already read it');
  for (const empty of [undefined, {}, { handoff: '  ' }, { handoff: 3 }]) assert.equal(withHandoff('p', stage, empty, 'new'), 'p', JSON.stringify(empty));
});

test('HANDOFF_PROMPT asks the session for hive_done with its handoff (#692)', () => {
  assert.match(HANDOFF_PROMPT, /hive_done with \{ "handoff": "<text>" \}/);
});

test('a terminal\'s env names its own history file, puts the Hive\'s bin dir first on PATH, joined with ; on win32 and : elsewhere, names the init files\' folder, and sets HIVE_PWSH only on win32 with a path (#696, #259, #645)', () => {
  const pwsh = 'C:\\t\\PowerShell\\7\\pwsh.exe';
  assert.deepEqual(terminalEnv('/h', 'T1', '/usr/bin:/bin', { platform: 'darwin', pwsh }), {
    HISTFILE: join('/h', 'terminals', 'T1.history'), PATH: `${join('/h', 'bin')}:/usr/bin:/bin`, HIVE_SHELL_DIR: join('/h', 'shell'),
  });
  assert.equal(terminalEnv('/h', 'T1', '', { platform: 'linux' }).PATH, join('/h', 'bin'));
  const win = terminalEnv('C:\\h', 'T1', 'C:\\Windows;C:\\bin', { platform: 'win32', pwsh });
  assert.deepEqual([win.PATH, win.HIVE_PWSH], [`${join('C:\\h', 'bin')};C:\\Windows;C:\\bin`, pwsh]);
  assert.equal('HIVE_PWSH' in terminalEnv('C:\\h', 'T1', 'C:\\bin', { platform: 'win32' }), false, 'no PowerShell found: the plain $SHELL');
});

test('windowsShell answers pwsh.exe\'s full path when both are found, powershell.exe\'s when only that one is, one on PATH after the install folders, and nothing when neither is or off win32 (#645)', () => {
  const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', Path: 'C:\\bin', PATHEXT: '.COM;.EXE' };
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const found = (...files: string[]) => (file: string): boolean => files.includes(file);
  assert.equal(windowsShell(env, 'win32', found(pwsh, powershell)), pwsh);
  assert.equal(windowsShell(env, 'win32', found(powershell)), powershell);
  assert.equal(windowsShell(env, 'win32', found('C:\\bin\\pwsh.exe', powershell)), powershell, 'both fixed folders before PATH');
  assert.equal(windowsShell(env, 'win32', found('C:\\bin\\pwsh.exe', 'C:\\bin\\powershell.exe')), 'C:\\bin\\pwsh.exe', 'on PATH, pwsh first');
  assert.equal(windowsShell(env, 'win32', found('C:\\bin\\pwsh.cmd', 'C:\\bin\\powershell.exe')), 'C:\\bin\\powershell.exe', 'a planted pwsh.cmd never runs');
  assert.equal(windowsShell({ ...env, PATHEXT: '.CMD;.EXE' }, 'win32', found('C:\\bin\\pwsh.cmd')), undefined, 'only an .exe, whatever PATHEXT says');
  assert.equal(windowsShell(env, 'win32', found()), undefined);
  assert.equal(windowsShell(env, 'darwin', found(pwsh)), undefined);
});

const CLOSED_PORT = 9; // the trailer's exit report goes nowhere
// The runner's env minus SHELL and the Hive's own names: each run below sets exactly the ones it names
const BARE_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'SHELL' && !name.startsWith('HIVE_')));

// A stand-in for $HIVE_PWSH or $SHELL that prints its tag and then its argv, one per line. A name with backslashes is one file of that
// name on darwin and linux, and folders under `dir` on win32: either way the case line must read the last part as the shell's name
async function stub(dir: string, name: string, tag: string): Promise<string> {
  const path = join(dir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' ${tag} "$@"\n`, { mode: 0o755 });
  return path;
}

// The terminal's line under the POSIX shell, as the pty host runs it: the stub's lines only. The trailer's curl fails on the closed port, so
// the exit code is not the shell's
// `prefix` runs first in the same shell: an assignment there sets a variable the line sees but that is not exported
function runLine(cwd: string, env: Record<string, string>, prefix = '', shell = posixShell().shell): Promise<string[]> {
  const line = prefix + ptyCommand({ ...LAUNCH, terminal: true, cwd, port: CLOSED_PORT });
  const full = { ...BARE_ENV, HIVE_SHELL_DIR: '/hs', HIVE_SECRET_FILE: '/dev/null', ...env };
  return new Promise((resolve) => {
    execFile(shell, ['-c', line], { env: full, encoding: 'utf8' }, (_err, stdout) => resolve(stdout.split(/\r?\n/).filter((l) => l !== '')));
  });
}

// A bash outside POSIX mode, as Git's sh.exe is (bash does not take sh.exe for sh): its export -p prints declare -x, not export
const PLAIN_BASH = '/bin/bash';
const noPlainBash = process.platform === 'win32' ? 'the lane\'s own sh.exe is already a bash outside POSIX mode' : !existsSync(PLAIN_BASH) && 'no /bin/bash here';

test('an exported SHELL naming bash wins over HIVE_PWSH under a bash outside POSIX mode too, whose export -p says declare -x (#645)', { skip: noPlainBash }, async (t: TestContext) => {
  const dir = await tempDir(t, 'terminal line-');
  const env = { HIVE_PWSH: await stub(dir, 'pwsh', 'pwsh'), SHELL: await stub(dir, 'bash', 'bash') };
  assert.deepEqual(await runLine(dir, env, '', PLAIN_BASH), ['bash', '--rcfile', '/hs/bash/rc']);
});

test('a terminal\'s line holds no backslash: Git\'s sh.exe reads its command line with \\\\ turned into \\ (#645)', () => {
  assert.equal(ptyCommand({ ...LAUNCH, terminal: true, cwd: '/wt' }).includes('\\'), false);
});

test('a terminal with HIVE_PWSH and no SHELL starts PowerShell on the loader, though the POSIX shell, bash on macOS and Windows, sets an unexported SHELL of its own (#645)', async (t: TestContext) => {
  const dir = await tempDir(t, 'terminal line-');
  assert.equal(PWSH_LOADER.includes("'"), false, 'the loader is one sh single-quoted word');
  assert.deepEqual(await runLine(dir, { HIVE_PWSH: await stub(dir, 'pwsh', 'pwsh') }), ['pwsh', '-NoLogo', '-NoProfile', '-NoExit', '-Command', PWSH_LOADER]);
});

test('a SHELL naming bash, by a POSIX path or by a Windows one with .exe, wins over HIVE_PWSH and starts bash on the Hive\'s rc file (#645)', async (t: TestContext) => {
  const dir = await tempDir(t, 'terminal line-');
  const pwsh = await stub(dir, 'pwsh', 'pwsh');
  for (const [name, tag] of [['bash', 'posix-bash'], ['Program Files\\Git\\bin\\bash.exe', 'windows-bash']]) {
    assert.deepEqual(await runLine(dir, { HIVE_PWSH: pwsh, SHELL: await stub(dir, name, tag) }), [tag, '--rcfile', '/hs/bash/rc'], name);
  }
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

test('ptyCommand quotes the agent\'s command as one word: a Windows full path with spaces and backslashes stays whole (#633)', () => {
  const line = ptyCommand({ ...LAUNCH, agent: { command: 'C:\\Program Files\\Claude\\claude.exe', argv: ['--version'] } });
  assert.ok(line.includes("HIVE_PORT=4242 'C:\\Program Files\\Claude\\claude.exe' '--version' "), line);
  assert.ok(ptyCommand({ ...LAUNCH, agent: { command: 'claude', argv: [] } }).includes("HIVE_PORT=4242 'claude' "), 'on darwin \'claude\' runs exactly what claude did');
});

test('without HIVE_PWSH a SHELL naming bash starts bash on the Hive\'s rc file even when it is not exported, as before #645 (#645)', async (t: TestContext) => {
  const dir = await tempDir(t, 'terminal line-');
  const bash = await stub(dir, 'bash', 'bash');
  assert.deepEqual(await runLine(dir, {}, `SHELL=${shellQuote(bash)}; `), ['bash', '--rcfile', '/hs/bash/rc']);
});
