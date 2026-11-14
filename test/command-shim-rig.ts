// The command shim's test rig (#800, #801): a fake daemon on loopback, the shim rendered in a folder first on PATH and a fake real binary.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { commandShimSource, renderCommandShim } from '../src/command-shim.js';
import { SECRET_HEADER } from '../src/secret.js';
import { NO_POSIX_SHELL } from './posix-only.js';
import { tempDir } from './temp-dir.js';

export const WORD = 'pnpm';
export const SECRET = 'test-secret'; // a header line for curl's -H @file, never a real token
export const ACQUIRE = '/hooks/semaphores/acquire';
export const RELEASE = '/hooks/semaphores/release';
export const FAKE_EXIT = 7;
export const REFUSED_EXIT = 75;
export const SHIM_TIMEOUT_MS = 10_000;
export const NO_ANSWER_MS = 3_000; // the shim's -m 2, plus the binary's own run
export const POSIX = { skip: NO_POSIX_SHELL };

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

export interface Seen { path: string; pty?: string; secret?: string; body: string; childDone: boolean }
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
      seen.push({ path: req.url ?? '', pty: req.headers['x-hive-pty']?.toString(), secret: req.headers[SECRET_HEADER]?.toString(), body, childDone: isChildDone() });
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

// The shim rendered as installCommandShims renders it, in a folder first on PATH, then the fake binary's folder, then the system's for sh,
// curl and sleep. The env is a Hive pty's, as ptyEnv gives it: HIVE_PTY_ID, HIVE_PORT and the secret's header file
export async function rig(root: string, port: number, word: string): Promise<Rig> {
  const shims = join(root, 'command-shims');
  const real = join(root, 'real');
  await mkdir(shims);
  await mkdir(real);
  const shim = join(shims, word);
  await writeFile(shim, renderCommandShim(await readFile(commandShimSource(), 'utf8'), word, 'en'));
  await chmod(shim, 0o755);
  if (word === WORD) {
    await writeFile(join(real, word), FAKE);
    await chmod(join(real, word), 0o755);
  }
  const secretFile = join(root, 'hive.secret');
  await writeFile(secretFile, `${SECRET_HEADER}: ${SECRET}\n`);
  const done = join(root, 'done');
  const env = { HOME: root, PATH: [shims, real, process.env.PATH ?? ''].join(':'), HIVE_PTY_ID: 'R1', HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile, FAKE_DONE: done };
  return { root, shim, done, env };
}

export async function setup(t: TestContext, answer: Answer, word = WORD): Promise<{ r: Rig; seen: Seen[] }> {
  const root = await tempDir(t, 'command-shim-');
  const { port, seen } = await fakeDaemon(t, answer, () => existsSync(join(root, 'done')));
  return { r: await rig(root, port, word), seen };
}

// The shim under sh, as a pty's shell runs a PATH hit; HOME is the rig's, so no ~/.curlrc of the machine's reaches curl
// closedStdin: the shim started by `sh` with fd 0 closed (`<&-`), under that sh
export interface ShimOptions { stdin?: string; env?: NodeJS.ProcessEnv; closedStdin?: string }
export function startShim(r: Rig, args: readonly string[], o: ShimOptions = {}): { pid: number; kill(signal: NodeJS.Signals): void; done: Promise<Ran> } {
  const started = Date.now();
  const argv = o.closedStdin === undefined ? [r.shim, ...args] : ['-c', `exec ${o.closedStdin} "$0" "$@" <&-`, r.shim, ...args];
  const child = spawn(o.closedStdin ?? '/bin/sh', argv, { env: { ...r.env, ...o.env }, timeout: SHIM_TIMEOUT_MS });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  child.stdin.end(o.stdin ?? '');
  const done = new Promise<Ran>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started })));
  return { pid: child.pid ?? 0, kill: (signal) => { child.kill(signal); }, done };
}
export const runShim = (r: Rig, args: readonly string[], o?: ShimOptions): Promise<Ran> => startShim(r, args, o).done;

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) await sleep(10);
  assert.ok(check(), 'never happened');
}
