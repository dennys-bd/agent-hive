// The command shim's test rig (#800, #801): a fake daemon on loopback, the shim rendered in a folder first on PATH and a fake real binary.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pty from 'node-pty';
import { isPidAlive } from '../src/command-semaphores.js';
import { commandShimSource, renderCommandShim } from '../src/command-shim.js';
import { envValue } from '../src/exec-path.js';
import { posixShell, posixShellEnv } from '../src/posix-shell.js';
import { SECRET_HEADER } from '../src/secret.js';
import { tempDir } from './temp-dir.js';

export const WORD = 'pnpm';
export const SECRET = 'test-secret'; // a header line for curl's -H @file, never a real token
export const ACQUIRE = '/hooks/semaphores/acquire';
export const RELEASE = '/hooks/semaphores/release';
export const FAKE_EXIT = 7;
export const REFUSED_EXIT = 75;
export const SHIM_TIMEOUT_MS = 10_000;
export const NO_ANSWER_MS = 3_000; // the shim's -m 2, plus the binary's own run

// The real binary the shim finds: each arg on a line, then its stdin, a mark that it ended, and exit 7. With FAKE_PID_FILE: its pid there
// and a long sleep, for a signal to end
export const FAKE = `#!/bin/sh
if [ -n "\${FAKE_PID_FILE:-}" ]; then echo $$ > "$FAKE_PID_FILE"; exec sleep 30; fi
for a in "$@"; do printf 'arg:%s\\n' "$a"; done
printf 'stdin:%s\\n' "$(cat)"
: > "$FAKE_DONE"
exit ${FAKE_EXIT}
`;
export const fakeOut = (args: readonly string[], stdin = ''): string => [...args.map((a) => `arg:${a}`), `stdin:${stdin}`, ''].join('\n');

export interface Seen { path: string; pty?: string; secret?: string; body: string; childDone: boolean; pidAlive: boolean }
export interface Rig { root: string; shim: string; done: string; env: NodeJS.ProcessEnv }
export interface Ran { code: number | null; stdout: string; stderr: string; ms: number }

// The two routes on loopback, each request kept with whether the fake binary had ended by then. undefined: acquire never answers, as a
// stuck Hive; a function answers the n-th acquire (1 first) from its body, for a wait that moves (#801)
export type Answer = string | undefined | ((n: number, body: string) => string | undefined);
export async function fakeDaemon(t: TestContext, answer: Answer, isChildDone: () => boolean): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const pid = Number(new URLSearchParams(body).get('pid'));
      // #806 decision 5: the daemon probes the pid it got; an MSYS pid would not be a live Windows one
      const pidAlive = req.url === ACQUIRE && Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
      seen.push({ path: req.url ?? '', pty: req.headers['x-hive-pty']?.toString(), secret: req.headers[SECRET_HEADER]?.toString(), body, childDone: isChildDone(), pidAlive });
      if (req.url === RELEASE) res.writeHead(204).end();
      else {
        const text = typeof answer === 'function' ? answer(seen.filter((s) => s.path === ACQUIRE).length, body) : answer;
        if (text !== undefined) res.writeHead(200, { 'content-type': 'text/plain' }).end(`${text}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: (server.address() as AddressInfo).port, seen };
}

// On win32 sh.exe and curl need the runner's own env (SYSTEMROOT for sockets, #806), with one PATH key and MSYS's argument rule (#631);
// elsewhere the minimal env keeps the machine's own out of the shim
export const baseEnv = (): NodeJS.ProcessEnv => (process.platform === 'win32'
  ? { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')), ...posixShellEnv('win32') }
  : {});

/** A PATH of `dirs` first, then the test's own, for sh, curl and sleep. */
export const searchPath = (...dirs: string[]): string => [...dirs, envValue(process.env, 'PATH') ?? ''].join(delimiter);

// The shim rendered as installCommandShims renders it, in a folder first on PATH, then the fake binary's folder, then the system's for sh,
// curl and sleep. The env is a Hive pty's, as ptyEnv gives it: HIVE_PTY_ID, HIVE_PORT and the secret's header file
export async function rig(root: string, port: number, word: string, platform: NodeJS.Platform = process.platform): Promise<Rig> {
  const shims = join(root, 'command-shims');
  const real = join(root, 'real');
  await mkdir(shims);
  await mkdir(real);
  const shim = join(shims, word);
  await writeFile(shim, renderCommandShim(await readFile(commandShimSource(), 'utf8'), word, 'en', platform));
  await chmod(shim, 0o755);
  if (word === WORD) {
    await writeFile(join(real, word), FAKE);
    await chmod(join(real, word), 0o755);
  }
  const secretFile = join(root, 'hive.secret');
  await writeFile(secretFile, `${SECRET_HEADER}: ${SECRET}\n`);
  const done = join(root, 'done');
  const env = { ...baseEnv(), HOME: root, PATH: searchPath(shims, real), HIVE_PTY_ID: 'R1', HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile, FAKE_DONE: done };
  return { root, shim, done, env };
}

export async function setup(t: TestContext, answer: Answer, word = WORD, platform: NodeJS.Platform = process.platform): Promise<{ r: Rig; seen: Seen[] }> {
  const root = await tempDir(t, 'command-shim-');
  const { port, seen } = await fakeDaemon(t, answer, () => existsSync(join(root, 'done')));
  return { r: await rig(root, port, word, platform), seen };
}

// The shim under sh, as a pty's shell runs a PATH hit; HOME is the rig's, so no ~/.curlrc of the machine's reaches curl
// closedStdin: the shim started by `sh` with fd 0 closed (`<&-`), under that sh. lastArg: one more argument, appended by sh itself from
// SHIM_TEST_ARG, since a Windows command line cannot carry a line break to an MSYS program whole: Cygwin splits it there (#806)
export interface ShimOptions { stdin?: string; env?: NodeJS.ProcessEnv; closedStdin?: string; lastArg?: string }
export function startShim(r: Rig, args: readonly string[], o: ShimOptions = {}): { pid: number; kill(signal: NodeJS.Signals): void; done: Promise<Ran> } {
  const started = Date.now();
  const argv = o.closedStdin !== undefined ? ['-c', `exec ${o.closedStdin} "$0" "$@" <&-`, r.shim, ...args]
    : o.lastArg !== undefined ? ['-c', 'exec "$0" "$@" "$SHIM_TEST_ARG"', r.shim, ...args] : [r.shim, ...args];
  const env = { ...r.env, ...o.env, ...(o.lastArg === undefined ? {} : { SHIM_TEST_ARG: o.lastArg }) };
  const child = spawn(o.closedStdin ?? posixShell().shell, argv, { env, timeout: SHIM_TIMEOUT_MS });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  child.stdin.end(o.stdin ?? '');
  const done = new Promise<Ran>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started })));
  return { pid: child.pid ?? 0, kill: (signal) => { child.kill(signal); }, done };
}
export const runShim = (r: Rig, args: readonly string[], o?: ShimOptions): Promise<Ran> => startShim(r, args, o).done;

// tries: 10 ms each; the default is 5 s, and sh.exe in a ConPTY on the Windows lane may need longer (#806)
export async function until(check: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries && !check(); i += 1) await sleep(10);
  assert.ok(check(), 'never happened');
}

// A real terminal: the shim under the POSIX shell in a pty (a ConPTY on win32), as a task's terminal runs it
export function inTerminal(r: Rig): { term: pty.IPty; output(): string; exited: Promise<number> } {
  const term = pty.spawn(posixShell().shell, [r.shim, 'test'], { env: r.env as Record<string, string>, cols: 200, rows: 10 });
  let out = '';
  term.onData((d) => { out += d; });
  const exited = new Promise<number>((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
  return { term, output: () => out, exited };
}
