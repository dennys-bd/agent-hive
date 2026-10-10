// The editor's installs (#780): language servers and syntax packages in folders the Hive manages under <hiveHome>/editor/, never in the
// config. An install builds in a temp folder beside its target and is renamed into place at the end, so a failure or a cancel leaves the
// previous install as it was. The requires check and every step run with the daemon's env.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { download, type DownloadLimits, type Latest, latestOf, REGISTRIES, type Registries } from './editor-fetch.js';
import { githubStep, npmStep, openVsxStep, type StepContext, toolchainStep } from './editor-unpack.js';
import { findOnPath } from './formatter-detect.js';
import { type Arch, requiredTools, serverDef } from './languages.js';
import { type EditorInstallEvent, type EditorInstalls, type InstallAction, type InstallState, type InstallTarget, SERVER_IDS, type ServerId, SYNTAX_IDS, type SyntaxId } from './types.js';

export interface InstalledFile { version: string; installedAt: string }
export type ActOutcome = { status: 200 | 202; state: InstallState } | { status: 409; message: string };
export interface InstallerDeps {
  home: string;
  onState(event: EditorInstallEvent): void; // the state stream's editorInstall
  env?(): NodeJS.ProcessEnv; // the daemon's; a test passes its stubs' PATH
  registries?: Registries;
  arch?: Arch;
  downloads?: DownloadLimits; // a test's: plain http to its local registry, a small cap
  beforeSwap?(target: InstallTarget): Promise<void>; // the item's running processes stop here: an update moves the folder they read from
}
export interface Installer {
  installs(): Promise<EditorInstalls>;
  act(target: InstallTarget, action: InstallAction): Promise<ActOutcome>;
}

const INSTALLED = 'installed.json';
const LATEST_CAP_MS = 5_000;
const RUN_OUTPUT_MAX = 16 * 1024 * 1024;
const VERSION_CAP_MS = 5_000;
const SDK_VERSION = /(\d+\.\d+\.\d+[\w.+-]*)/;
const isSystem = (target: InstallTarget): boolean => target.kind === 'server' && serverDef(target.id).install === 'system';

// A server that ships with its SDK (#782): installed while its tool is on PATH, at the version the tool prints; nothing of the Hive's on disk
async function systemState(tool: string, env: NodeJS.ProcessEnv): Promise<InstallState> {
  const binary = await findOnPath(tool, env.PATH ?? '');
  if (binary === undefined) return { state: 'requires', tool };
  const printed = await new Promise<string>((resolve) => {
    execFile(binary, ['--version'], { env, timeout: VERSION_CAP_MS, encoding: 'utf8' }, (_err, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
  return { state: 'installed', version: SDK_VERSION.exec(printed)?.[1] ?? 'unknown' };
}

/** Where an item lives (#780): <hiveHome>/editor/servers/<id> or <hiveHome>/editor/syntax/<id>. */
export const editorDir = (home: string, target: InstallTarget): string => join(home, 'editor', target.kind === 'server' ? 'servers' : 'syntax', target.id);

const isInstalledFile = (raw: unknown): raw is InstalledFile =>
  typeof raw === 'object' && raw !== null && typeof (raw as InstalledFile).version === 'string' && typeof (raw as InstalledFile).installedAt === 'string';

/** An item's installed.json, undefined for none or one that does not read (#780). */
export async function readInstalled(home: string, target: InstallTarget): Promise<InstalledFile | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(editorDir(home, target), INSTALLED), 'utf8'));
    return isInstalledFile(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

const keyOf = (target: InstallTarget): string => `${target.kind}:${target.id}`;

// A promise's value, or undefined once `ms` pass or it fails: a slow registry never holds Settings
const withCap = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(undefined), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
});

// The finished temp folder in place of the old install, which goes only once the new one is there
async function swapInto(tmp: string, dir: string): Promise<void> {
  const old = `${tmp}.old`;
  const hadOld = await rename(dir, old).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });
  await rename(tmp, dir);
  if (hadOld) await rm(old, { recursive: true, force: true });
}

// A program's failure in the log's last line: never Node's message, which holds the whole command line
function stepError(command: string, err: Error & { code?: string | number | null }): Error {
  if (err.code === 'ENOENT') return new Error(`${command} not found`);
  if (err.name === 'AbortError') return new Error('cancelled');
  return new Error(typeof err.code === 'number' ? `${command} exited with code ${err.code}` : `${command} failed`);
}

interface Job { log: string[]; step: string; version: string }

function runStep(command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, job: Job): Promise<string> {
  job.step = [command, args[0]].filter((part) => part !== undefined).join(' ');
  job.log.push(`> ${job.step}`);
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, signal, maxBuffer: RUN_OUTPUT_MAX, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (stderr.trim() !== '') job.log.push(stderr.trimEnd());
      if (err) reject(stepError(command, err));
      else resolve(stdout);
    });
  });
}

class EditorInstaller implements Installer {
  private readonly running = new Map<string, { controller: AbortController; percent?: number }>();
  private readonly failed = new Map<string, { version: string; step: string; log: string }>();
  private readonly deps: InstallerDeps;
  private readonly registries: Registries;
  private readonly arch: Arch;

  constructor(deps: InstallerDeps) {
    this.deps = deps;
    this.registries = deps.registries ?? REGISTRIES;
    this.arch = deps.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  }

  private env(): NodeJS.ProcessEnv { return this.deps.env?.() ?? process.env; }

  async installs(): Promise<EditorInstalls> {
    const servers = await Promise.all(SERVER_IDS.map(async (id) => [id, await this.listed({ kind: 'server', id })] as const));
    const syntaxes = await Promise.all(SYNTAX_IDS.map(async (id) => [id, await this.listed({ kind: 'syntax', id })] as const));
    return { servers: Object.fromEntries(servers) as Record<ServerId, InstallState>, syntaxes: Object.fromEntries(syntaxes) as Record<SyntaxId, InstallState> };
  }

  // A listed item: an installed one gains the latest version, looked up within LATEST_CAP_MS
  private async listed(target: InstallTarget): Promise<InstallState> {
    const state = await this.stateOf(target);
    if (state.state !== 'installed' || isSystem(target)) return state; // the SDK updates itself: no latest to look up
    const latest = await withCap(latestOf(target, this.registries, this.arch, AbortSignal.timeout(LATEST_CAP_MS)).then((l) => l.version), LATEST_CAP_MS);
    return latest === undefined ? state : { ...state, latest };
  }

  // What an item is now: installing, a missing tool, a failure, installed, else absent
  private async stateOf(target: InstallTarget): Promise<InstallState> {
    if (target.kind === 'server') {
      const def = serverDef(target.id);
      if (def.install === 'system') return systemState(def.source, this.env());
    }
    const run = this.running.get(keyOf(target));
    if (run) return run.percent === undefined ? { state: 'installing' } : { state: 'installing', percent: run.percent };
    const tool = await this.missingTool(target);
    if (tool !== undefined) return { state: 'requires', tool };
    const failure = this.failed.get(keyOf(target));
    if (failure) return { state: 'failed', ...failure };
    const installed = await readInstalled(this.deps.home, target);
    return installed ? { state: 'installed', version: installed.version } : { state: 'absent' };
  }

  private async missingTool(target: InstallTarget): Promise<string | undefined> {
    if (target.kind !== 'server') return undefined;
    const path = this.env().PATH ?? '';
    for (const tool of requiredTools(serverDef(target.id))) {
      if ((await findOnPath(tool, path)) === undefined) return tool;
    }
    return undefined;
  }

  async act(target: InstallTarget, action: InstallAction): Promise<ActOutcome> {
    if (isSystem(target) && (action === 'install' || action === 'update')) return { status: 409, message: `${target.id} comes with its SDK: nothing to install` };
    if (action === 'install' || action === 'update') return this.start(target);
    if (action === 'cancel') this.running.get(keyOf(target))?.controller.abort();
    if (action === 'remove') await this.remove(target);
    return this.answer(target, 200);
  }

  private async answer(target: InstallTarget, status: 200 | 202): Promise<ActOutcome> {
    const state = await this.stateOf(target);
    this.deps.onState({ ...target, state } as EditorInstallEvent);
    return { status, state };
  }

  // One install per item: the running entry is set before any await, so a second request meets it
  private async start(target: InstallTarget): Promise<ActOutcome> {
    const key = keyOf(target);
    if (this.running.has(key)) return { status: 409, message: `${target.id} is already installing` };
    const controller = new AbortController();
    this.running.set(key, { controller });
    if ((await this.missingTool(target)) !== undefined) {
      this.running.delete(key);
      return this.answer(target, 200);
    }
    this.failed.delete(key);
    void this.job(target, controller);
    return this.answer(target, 202);
  }

  private async remove(target: InstallTarget): Promise<void> {
    this.running.get(keyOf(target))?.controller.abort();
    this.failed.delete(keyOf(target));
    await rm(editorDir(this.deps.home, target), { recursive: true, force: true });
  }

  private progress(target: InstallTarget, percent: number): void {
    const run = this.running.get(keyOf(target));
    if (run === undefined || run.percent === percent) return;
    this.running.set(keyOf(target), { ...run, percent });
    this.deps.onState({ ...target, state: { state: 'installing', percent } } as EditorInstallEvent);
  }

  private async job(target: InstallTarget, controller: AbortController): Promise<void> {
    const dir = editorDir(this.deps.home, target);
    const tmp = join(dirname(dir), `.${target.id}.tmp-${randomBytes(4).toString('hex')}`);
    const job: Job = { log: [], step: 'lookup', version: '' };
    try {
      const latest = await latestOf(target, this.registries, this.arch, controller.signal);
      job.version = latest.version;
      await mkdir(tmp, { recursive: true });
      const version = await this.step(target, latest, this.context(target, tmp, controller.signal, job));
      job.step = 'move';
      await writeFile(join(tmp, INSTALLED), JSON.stringify({ version, installedAt: new Date().toISOString() } satisfies InstalledFile));
      await this.deps.beforeSwap?.(target);
      await swapInto(tmp, dir);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      const line = err instanceof Error ? err.message : String(err);
      if (!controller.signal.aborted) this.failed.set(keyOf(target), { version: job.version, step: job.step, log: [...job.log, line].join('\n') });
    } finally {
      this.running.delete(keyOf(target));
      // this chain is voided: a throw here (the state read) would be an unhandled rejection
      await this.answer(target, 200).catch(() => undefined);
    }
  }

  private context(target: InstallTarget, tmp: string, signal: AbortSignal, job: Job): StepContext {
    return {
      tmp, arch: this.arch, env: this.env(),
      run: (command, args, env = this.env()) => runStep(command, args, env, signal, job),
      download: (url, file) => { job.step = 'download'; return download(url, file, signal, (percent) => this.progress(target, percent), this.deps.downloads); },
    };
  }

  private step(target: InstallTarget, latest: Latest, ctx: StepContext): Promise<string> {
    if (target.kind === 'syntax') return openVsxStep(latest, ctx);
    const def = serverDef(target.id);
    if (def.install === 'npm') return npmStep(def, ctx);
    return def.install === 'toolchain' ? toolchainStep(def, latest, ctx) : githubStep(def, latest, ctx);
  }
}

/** The editor's installer (#780): its state per item lives in this process, its installs on the disk. */
export const createInstaller = (deps: InstallerDeps): Installer => new EditorInstaller(deps);
