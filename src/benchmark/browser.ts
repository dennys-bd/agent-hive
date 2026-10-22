// The Playwright MCP and Chromium a benchmark run's tester drives (#474), moved from the harness: nothing here knows the dashboard.
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { withoutHiveEnv } from '../spawn.js';

export const VIEWPORT = { width: 1440, height: 900 }; // the handoff's reference size (00-LEIA-ANTES.md)
export const SOCKETS_PREFIX = '/tmp/hive-pw-'; // a socket path caps at 104 bytes on macOS: the per-user TMPDIR overflows it
export const CHROMIUM_INSTALL_MS = 10 * 60_000;
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }; // src/daemon.ts: Electron's execPath runs a script as plain Node only with it

export interface McpConfigInput { bin: string; outputDir: string; origin: string; chromiumPath: string; socketsDir: string; storage?: string }
export interface McpServerConfig { command: string; args: string[]; env: Record<string, string> }
export interface ChromiumDeps { executablePath(): Promise<string>; exists(path: string): boolean; install(): Promise<void> }

export function mcpConfig(o: McpConfigInput): { mcpServers: { playwright: McpServerConfig } } {
  const args = [
    o.bin, '--executable-path', o.chromiumPath, // the Chromium the root playwright installed: --browser chromium alone would look for chrome-for-testing
    '--browser', 'chromium', '--headless', '--isolated', ...(o.storage === undefined ? [] : ['--storage-state', o.storage]),
    '--output-dir', o.outputDir, '--viewport-size', `${VIEWPORT.width},${VIEWPORT.height}`,
    '--allowed-origins', o.origin, // the sample only: no file:// or other page the tester could learn the run from
  ];
  return { mcpServers: { playwright: { command: process.execPath, args, env: { PWTEST_SOCKETS_DIR: o.socketsDir, ...NODE_ENV } } } };
}

// A package's bin through its own package.json: node_modules/.bin assumed the repo root as cwd, which a packaged app does not have
export async function packageBin(pkg: string, name: string): Promise<string> {
  const manifest = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
  const { bin } = JSON.parse(await readFile(manifest, 'utf8')) as { bin?: string | Record<string, string> };
  const file = typeof bin === 'string' ? bin : bin?.[name];
  if (file === undefined) throw new Error(`${pkg} has no ${name} bin`);
  return join(dirname(manifest), file);
}

export const mcpBinary = (): Promise<string> => packageBin('@playwright/mcp', 'playwright-mcp');

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';

const defaultChromium: ChromiumDeps = {
  executablePath: async () => (await import('playwright')).chromium.executablePath(),
  exists: existsSync,
  install: async () => {
    const cli = await packageBin('playwright', 'playwright');
    await promisify(execFile)(process.execPath, [cli, 'install', 'chromium'], { timeout: CHROMIUM_INSTALL_MS, env: { ...process.env, ...NODE_ENV } });
  },
};

/** The Chromium Playwright drives, installed on first use (root design): no install at pnpm install time. */
export async function ensureChromium(deps: ChromiumDeps = defaultChromium): Promise<{ path: string } | { reason: string }> {
  try {
    const path = await deps.executablePath();
    if (deps.exists(path)) return { path };
    await deps.install();
    return deps.exists(path) ? { path } : { reason: 'Chromium is not installed: the install left no browser' };
  } catch (err) {
    return { reason: `Chromium is not installed: ${firstLine(err)}` };
  }
}

// @playwright/mcp writes a screenshot the tester names into its workspace root, and only an unnamed one under --output-dir: every PNG in the
// folder is kept, one in a subfolder named by its path (screens/x.png is screens-x.png), behind the prefix (the walk's number)
export async function keepShots(from: string, to: string, prefix = ''): Promise<string[]> {
  await mkdir(to, { recursive: true });
  const shots = (await readdir(from, { recursive: true })).filter((name) => name.endsWith('.png')).sort();
  const kept = shots.map((shot) => `${prefix}${shot.split(sep).join('-')}`);
  await Promise.all(shots.map((shot, i) => copyFile(join(from, shot), join(to, kept[i] ?? ''))));
  return kept;
}

export const SAMPLE_READY_MS = 5 * 60_000;
export const SAMPLE_POLL_MS = 1_000;
export const SAMPLE_STOP_GRACE_MS = 5_000;
export interface SampleChild { readonly pid?: number; readonly exitCode: number | null; once(event: 'exit', listener: () => void): unknown }
export type SpawnSample = (file: string, args: readonly string[], options: SpawnOptions) => SampleChild;
export interface StopDeps { kill(pid: number, signal: NodeJS.Signals): void; graceMs: number }
export interface ReadyDeps { fetch(url: string, init: { signal: AbortSignal }): Promise<{ status: number }>; now(): number; sleep(ms: number): Promise<void>; exited(): boolean; deadlineMs?: number }

/** The seed's sample app (#474), the fourth deliberate shell string (CLAUDE.md): `command` is the user's own line from the seed, run whole
 *  through their shell in the eval worktree and never interpolated. Its own process group, so stopSample takes its children too. */
export function startSample(command: string, cwd: string, spawnSample: SpawnSample = spawn, env: NodeJS.ProcessEnv = process.env): SampleChild {
  return spawnSample(env.SHELL ?? '/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'ignore', env: { ...withoutHiveEnv(env), CI: '1' } });
}

const isGone = (err: unknown): boolean => (err as { code?: unknown }).code === 'ESRCH';

// ponytail: waits on the shell alone; a child that ignores SIGTERM in a group whose shell already exited gets no SIGKILL
export async function stopSample(child: SampleChild, deps: StopDeps = { kill: (pid, signal) => process.kill(pid, signal), graceMs: SAMPLE_STOP_GRACE_MS }): Promise<void> {
  if (child.pid === undefined) return;
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
  try {
    deps.kill(-child.pid, 'SIGTERM');
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
  if (child.exitCode !== null) return;
  const late = await Promise.race([exited, delay(deps.graceMs, false, { ref: false })]);
  if (late) return;
  try {
    deps.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/** Polls the sample's URL every second until any status below 500 answers (#474): a generic app has only its URL to wait on. */
export async function waitReady(url: string, deps: ReadyDeps): Promise<string | undefined> {
  const deadlineMs = deps.deadlineMs ?? SAMPLE_READY_MS;
  const until = deps.now() + deadlineMs;
  for (;;) {
    if (deps.exited()) return 'the sample did not start: its command exited';
    const status = await deps.fetch(url, { signal: AbortSignal.timeout(SAMPLE_POLL_MS) }).then((res) => res.status, () => undefined);
    if (status !== undefined && status < 500) return undefined;
    if (deps.now() >= until) return `the sample did not start: no answer from ${url} in ${Math.round(deadlineMs / 1000)} s`;
    await deps.sleep(SAMPLE_POLL_MS);
  }
}
