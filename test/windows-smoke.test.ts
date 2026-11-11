import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readDaemonPort, readDaemonSecret } from '../src/daemon-files.js';
import { SECRET_HEADER } from '../src/secret.js';
import { shellQuote } from '../src/shell-init.js';
import type { Activity, State } from '../src/types.js';
import { samePath } from '../src/same-path.js';
import { killQuietly } from './daemon-boot.js';
import { combConfig } from './fakes.js';
import { tempDir } from './temp-dir.js';

// The daemon smoke of the Windows lane (#653): the compiled run.js booted as a real process on a home built from nothing, a task whose only
// stage runs one command in its worktree, the single-instance refusal, the stop, and a reboot on the freed home. No token, no agent.
const RUN_JS = fileURLToPath(new URL('../src/run.js', import.meta.url));
const MARKER = 'hive-smoke-marker';
const EXIT_CODE = 3;
const STEP_MS = 100;
const BOOT_MS = 60_000;
const EXIT_MS = 30_000;
const TASK_MS = 90_000;
const run = promisify(execFile);

async function until<T>(what: string, ms: number, read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    const found = await Promise.resolve(read()).catch((err: unknown) => { last = err; return undefined; });
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`, { cause: last });
    await sleep(STEP_MS);
  }
}

// unref'd, so the timer that lost the race does not hold the process for EXIT_MS
const exitedIn = (ms: number): Promise<string> => sleep(ms, 'timeout', { ref: false });

async function repoWithOneCommit(t: TestContext): Promise<string> {
  const repo = await tempDir(t, 'smoke-repo-');
  const git = (...args: string[]) => run('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
  await git('init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'smoke\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
  return repo;
}

// A Comb with no source and one flow whose only stage runs the `smoke` command (#755): a node script that prints the marker and where it ran,
// and exits EXIT_CODE. The line goes through the shell the command runs through, so the paths are quoted for it.
// The cwd goes to a file, not the output: a pty wraps a long temp path at its width, and ConPTY inserts escapes into the wrap
async function fixtureHome(t: TestContext): Promise<{ home: string; cwdFile: string }> {
  const home = await tempDir(t, 'smoke-home-');
  const repo = await repoWithOneCommit(t);
  const folder = await tempDir(t, 'smoke-script-');
  const script = join(folder, 'smoke.cjs');
  const cwdFile = join(folder, 'cwd.txt');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());\nconsole.log('${MARKER}');\nprocess.exit(${EXIT_CODE});\n`);
  const stage = { name: 'fila', from: {}, action: 'commands', commands: ['smoke'], stopOnFailure: true, onMissing: 'fail' };
  const commands = [{ name: 'smoke', impls: [{ workspace: null, command: `${shellQuote(process.execPath)} ${shellQuote(script)}` }], menu: false, env: {} }];
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ stages: [stage], path: repo, commands })));
  return { home, cwdFile };
}

interface Daemon { child: ChildProcess; exit: Promise<number | null>; port: number; secret: string }

function launch(t: TestContext, home: string): { child: ChildProcess; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [RUN_JS], { env: { ...process.env, HIVE_HOME: home }, stdio: 'ignore' });
  t.after(() => killQuietly(child.pid));
  return { child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

async function boot(t: TestContext, home: string): Promise<Daemon> {
  const started = launch(t, home);
  const base = await until('hive.port and hive.secret', BOOT_MS, () => {
    const port = readDaemonPort(home);
    const secret = readDaemonSecret(home);
    return port === undefined || secret === undefined ? undefined : { port, secret };
  });
  return { ...started, ...base };
}

const call = (d: Daemon, path: string, body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${d.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { [SECRET_HEADER]: d.secret, 'x-hive-ui': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// The State the daemon serves: the first message of its event stream
async function stateOf(d: Daemon): Promise<State> {
  const abort = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/events`, { headers: { [SECRET_HEADER]: d.secret }, signal: abort.signal });
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes('\n\n')) break;
    }
    return JSON.parse(text.slice('data: '.length, text.indexOf('\n\n'))) as State;
  } finally {
    abort.abort();
  }
}

async function stopAndExpectCleanExit(d: Daemon): Promise<void> {
  assert.equal((await call(d, '/stop', {})).status, 200);
  const code = await Promise.race([d.exit, exitedIn(EXIT_MS)]);
  assert.equal(code, 0, 'POST /stop ends the daemon with exit code 0');
}

async function runStage(d: Daemon): Promise<{ output: string; activity: Activity }> {
  const created = await call(d, '/tasks', { title: 'smoke', stage: 'fila', auto: false });
  assert.equal(created.status, 201);
  const { itemId } = (await created.json()) as { itemId: string };
  assert.equal((await call(d, `/tasks/${itemId}/start`, { base: null })).status, 200);
  return until('the stage command to end', TASK_MS, async () => {
    const state = await stateOf(d);
    const output = state.activityRecords.map((r) => (r.result as { commands?: { verdict?: string; output?: string } } | undefined)?.commands)
      .find((c) => c?.verdict === 'failed')?.output;
    const activity = state.activities.find((a) => a.worktree !== undefined);
    return output === undefined || activity === undefined ? undefined : { output, activity };
  });
}

test('the daemon boots, runs a stage command in a task worktree, refuses a second instance, stops cleanly and boots again on the freed home (#653)', async (t) => {
  const { home, cwdFile } = await fixtureHome(t);
  const first = await boot(t, home);

  const second = launch(t, home);
  const refused = await Promise.race([second.exit, exitedIn(EXIT_MS)]);
  assert.ok(typeof refused === 'number' && refused !== 0, `a second daemon on the same home exits non-zero, got ${String(refused)}`);
  assert.match(await readFile(join(home, 'hive.log'), 'utf8'), /já está em execução/);

  const { output, activity } = await runStage(first);
  assert.ok(output.includes(`smoke (${EXIT_CODE})`), output);
  assert.ok(output.includes(MARKER), output);
  // realpath.native expands an 8.3 short name (RUNNER~1) the JS realpath keeps; samePath ignores case on win32 (#640)
  const ran = realpathSync.native(await readFile(cwdFile, 'utf8'));
  assert.ok(samePath(ran, realpathSync.native(activity.worktree as string), process.platform), `the command ran in the task's worktree, not ${ran}`);

  await stopAndExpectCleanExit(first);
  await stopAndExpectCleanExit(await boot(t, home));
});
