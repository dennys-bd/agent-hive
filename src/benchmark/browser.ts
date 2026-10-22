// The Playwright MCP and Chromium a benchmark run's tester drives (#474), moved from the harness: nothing here knows the dashboard.
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { runners } from '../agents/registry.js';
import type { HeadlessInput, HeadlessResult } from '../headless-run.js';
import { isRecord } from '../rate-limits.js';
import { withoutHiveEnv } from '../spawn.js';
import type { AgentId, BenchScenario, EvaluateRow, ScenarioResult } from '../types.js';

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
export const SAMPLE_STOP_POLL_MS = 100;
export interface SampleChild { readonly pid?: number; readonly exitCode: number | null; once(event: 'exit' | 'error', listener: () => void): unknown }
export type SpawnSample = (file: string, args: readonly string[], options: SpawnOptions) => SampleChild;
export interface StopDeps { kill(pid: number, signal: NodeJS.Signals | 0): void; graceMs: number }
export interface ReadyDeps { fetch(url: string, init: { signal: AbortSignal }): Promise<{ status: number }>; now(): number; sleep(ms: number): Promise<void>; exited(): boolean; deadlineMs?: number }

/** The seed's sample app (#474), the fourth deliberate shell string (CLAUDE.md): `command` is the user's own line from the seed, run whole
 *  through their shell in the eval worktree and never interpolated. Its own process group, so stopSample takes its children too. */
export function startSample(command: string, cwd: string, spawnSample: SpawnSample = spawn, env: NodeJS.ProcessEnv = process.env): SampleChild {
  return spawnSample(env.SHELL ?? '/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'ignore', env: { ...withoutHiveEnv(env), CI: '1' } });
}

// A stubborn child can outlive the shell in the group: signal 0 asks whether the group still has a member. The stop polls it until the group is
// gone or the grace runs out, and only a group still alive then gets SIGKILL. Never throws: it runs in a finally and must not replace the walk's results.
export async function stopSample(child: SampleChild, deps: StopDeps = { kill: (pid, signal) => process.kill(pid, signal), graceMs: SAMPLE_STOP_GRACE_MS }): Promise<void> {
  if (child.pid === undefined) return;
  const group = -child.pid;
  if (!signalGroup(group, 'SIGTERM', deps)) return;
  const until = Date.now() + deps.graceMs;
  while (signalGroup(group, 0, deps)) { // ref'd waits: a headless process must not exit mid-stop (close() bounds them)
    const left = until - Date.now();
    if (left <= 0) {
      signalGroup(group, 'SIGKILL', deps);
      return;
    }
    await delay(Math.min(SAMPLE_STOP_POLL_MS, left));
  }
}

// false: the group is gone (ESRCH), unreachable (EPERM, a zombie group on macOS) or the signal failed otherwise: every stop gives up then
function signalGroup(group: number, signal: NodeJS.Signals | 0, deps: StopDeps): boolean {
  try {
    deps.kill(group, signal);
    return true;
  } catch {
    return false;
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

export const TESTER_TIMEOUT_MS = 120 * 60_000; // the harness's tester budget, per walk
// What @playwright/mcp 0.0.83 exposes, minus evaluate, run code, file upload, install and the cookie, storage and network tools
export const TESTER_TOOLS: readonly string[] = ['navigate', 'navigate_back', 'click', 'hover', 'type', 'fill_form', 'press_key', 'select_option', 'snapshot', 'take_screenshot', 'wait_for', 'resize']
  .map((name) => `mcp__playwright__browser_${name}`);

export const TESTER_SCHEMA = {
  type: 'object',
  properties: { scenarios: { type: 'array', items: { type: 'object', properties: { scenario: { type: 'string' }, passed: { type: 'boolean' }, notes: { type: 'string' }, screenshots: { type: 'array', items: { type: 'string' } } }, required: ['scenario', 'passed', 'notes', 'screenshots'], additionalProperties: false } } },
  required: ['scenarios'], additionalProperties: false,
} as const;

const renderScenarios = (scenarios: readonly BenchScenario[]): string => scenarios.map((s) => `## ${s.id} · ${s.title}\n${s.text}`).join('\n\n');

/** The tester's prompt (#105, #474): the URL and the seed's scenarios; `intro` is the harness's dashboard text until #479 retires it. */
export function testerPrompt(o: { url: string; scenarios: readonly BenchScenario[]; intro?: string }): string {
  return [
    `You are testing a web app in a browser, through the Playwright tools only. Open ${o.url} first.`,
    'Never edit, create or delete a file, and never run a shell command.',
    ...(o.intro === undefined ? [] : [o.intro]),
    'Follow each scenario in order, exactly as written, and judge it only by its Expected part. Take a screenshot after every step, named <scenario id>-<step number>.png (S2-3.png is step 3 of S2). A scenario you cannot start counts as failed: say why in its notes.',
    'Your final message is only a JSON object with one entry per scenario, in order, like:\n{"scenarios": [{"scenario": "S1", "passed": true, "notes": "what you saw", "screenshots": ["S1-1.png"]}]}',
    `The scenarios:\n\n${renderScenarios(o.scenarios)}`,
  ].join('\n\n');
}

export interface Click { scenario: string; passed: boolean; notes: string; screenshots: string[] }
export interface WalkInput { tester: EvaluateRow; scenarios: readonly BenchScenario[]; walks: number; url: string; screens: string; chromiumPath: string; mcpBin: string }
export interface WalkDeps { headless(input: HeadlessInput): Promise<HeadlessResult>; log(line: string): void; signal: AbortSignal; tmpRoot: string }

function clickOf(raw: unknown, id: string): Click {
  if (!isRecord(raw)) return { scenario: id, passed: false, notes: 'not reported by the tester', screenshots: [] };
  const shots: unknown[] = Array.isArray(raw.screenshots) ? raw.screenshots : [];
  return { scenario: id, passed: raw.passed === true, notes: typeof raw.notes === 'string' ? raw.notes : '', screenshots: shots.filter((s): s is string => typeof s === 'string') };
}

export function parseClicks(raw: unknown, scenarios: readonly { id: string }[]): Click[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  return scenarios.map((s) => clickOf(list.find((c) => isRecord(c) && c.scenario === s.id), s.id));
}

export const testerRefusal = (agent: AgentId): string | undefined =>
  (runners[agent].headlessMcp ? undefined : `${agent} cannot run the tester (no MCP config in a headless run)`);

const failedClicks = (scenarios: readonly { id: string }[], notes: string): Click[] => scenarios.map((s) => ({ scenario: s.id, passed: false, notes, screenshots: [] }));
export const failedWalks = (scenarios: readonly { id: string }[], walks: number, reason: string): Click[][] =>
  Array.from({ length: walks }, () => failedClicks(scenarios, reason));

// The tester's answer under TESTER_SCHEMA; a run's screenshot names become the kept names under screens (`<walk>-<name>`)
function clicksOf(answer: string, input: WalkInput, kept: readonly string[], n: number): Click[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(answer);
  } catch {
    return undefined;
  }
  const keptName = (shot: string): string[] => (kept.includes(`${n}-${shot}`) ? [`${n}-${shot}`] : []);
  return parseClicks(isRecord(raw) ? raw.scenarios : undefined, input.scenarios).map((c) => ({ ...c, screenshots: c.screenshots.flatMap(keptName) }));
}

// One walk in a bare temp folder (0700) holding only the MCP config, so the tester never reads the worktree; gone when it returns
async function walkOnce(n: number, input: WalkInput, deps: WalkDeps): Promise<Click[]> {
  const review = await mkdtemp(join(deps.tmpRoot, 'hive-tester-'));
  const sockets = await mkdtemp(SOCKETS_PREFIX);
  try {
    const outputDir = join(review, 'screens');
    const config = join(review, 'mcp.json');
    await mkdir(outputDir);
    await writeFile(config, JSON.stringify(mcpConfig({ bin: input.mcpBin, outputDir, origin: new URL(input.url).origin, chromiumPath: input.chromiumPath, socketsDir: sockets })), { mode: 0o600 });
    const { tester } = input;
    const result = await deps.headless({
      agent: tester.agent, ...(tester.model === undefined ? {} : { model: tester.model }), prompt: testerPrompt({ url: input.url, scenarios: input.scenarios }),
      schema: TESTER_SCHEMA, signal: deps.signal, cwd: review, mcpConfig: config, allowedTools: TESTER_TOOLS, timeoutMs: TESTER_TIMEOUT_MS,
    }).catch((): HeadlessResult => ({ failure: 'could not start', detail: '' })); // a rejection must not lose the run's other results
    const kept = await keepShots(review, input.screens, `${n}-`);
    const failure = 'failure' in result ? result.failure : undefined;
    const clicks = failure === undefined && 'answer' in result ? clicksOf(result.answer, input, kept, n) : undefined;
    if (clicks !== undefined) return clicks;
    deps.log(`tester walk ${n}: ${failure ?? 'no JSON answer'}`);
    return failedClicks(input.scenarios, `the tester's walk ${n} failed: ${failure ?? 'no JSON answer'}`);
  } finally {
    await rm(review, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  }
}

/** `walks` separate tester runs, each over every scenario (#474): a fresh tester per walk is what makes a walk independent. */
export async function walkScenarios(input: WalkInput, deps: WalkDeps): Promise<Click[][]> {
  const walks: Click[][] = [];
  for (let n = 1; n <= input.walks; n += 1) {
    deps.signal.throwIfAborted(); // a Quit stops before the next walk
    walks.push(await walkOnce(n, input, deps));
  }
  return walks;
}

export const scenarioResults = (scenarios: readonly { id: string }[], walks: readonly Click[][]): ScenarioResult[] =>
  scenarios.map(({ id }) => {
    const clicks = walks.flatMap((walk) => walk.filter((c) => c.scenario === id));
    return { id, passed: clicks.filter((c) => c.passed).length, total: walks.length, screenshots: clicks.flatMap((c) => c.screenshots) };
  });
