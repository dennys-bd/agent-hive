import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import express from 'express';
import { benchmarkReduce } from '../../src/benchmark-reducer.js';
import { registerBenchmarkRoutes } from '../../src/server-benchmark.js';
import type { DraftCtx, DraftDeps } from '../../src/benchmark/drafts.js';
import type { Logger } from '../../src/log.js';
import type { BenchmarkEvent, Config, Exec, Experiment, State } from '../../src/types.js';
import { put } from '../custom-fixture.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';
import { benchConfig, SHA, stateWith } from './fixtures.js';

export const AT = '2026-10-21T12:00:00.000Z';
export const PLUGIN_FILES = { '.claude-plugin/plugin.json': '{"name":"hive","version":"0.1.0"}', 'skills/new-build/SKILL.md': 'ship\n' };
export const CUSTOM_FILES = { 'custom/hive/new-build/tdd/version.json': JSON.stringify({ name: 'tdd', from: 'original', workspaces: ['bench'] }), 'custom/hive/new-build/tdd/files/SKILL.md': 'tdd\n' };
// The folder of an experiment the state already holds: a pin, a seed, and a round's leftovers that no copy may carry
export const FOLDER_FILES = { 'plugin/source/skills/new-build/SKILL.md': 'pinned\n', 'plugin/custom/hive/new-build/tdd/version.json': '{}', 'seed/scenarios.md': '', 'seed/upload/old.txt': 'old\n', 'runs/aaaa1/hive.log': 'x' };

export interface BenchDeps {
  home: string; pluginSource: string; repo: string; calls: string[][]; lines: string[]; log: Logger; config: Config;
  events: BenchmarkEvent[]; deps: DraftDeps; state(): State; ctx(): DraftCtx; dir(id: string): string;
}
export interface Bench extends BenchDeps { base: string }
interface BenchOpts { experiments?: Experiment[]; files?: Record<string, string> }

// git as the routes call it, after `-C <repo>`: the base's symref and sha, and the files `files` holds at SHA; anything else fails as git does
function fakeGit(files: Record<string, string>): (args: string[]) => string {
  return (args) => {
    const [command, ...rest] = args;
    const spec = rest.at(-1) ?? '';
    const path = spec.slice(SHA.length + 1);
    if (command === 'symbolic-ref') return 'origin/main\n';
    if (command === 'rev-parse') return `${SHA}\n`;
    if (command === 'cat-file' && spec === SHA) return 'commit\n';
    if (command === 'cat-file' && Object.hasOwn(files, path)) return 'blob\n';
    if (command === 'show' && Object.hasOwn(files, path)) return files[path];
    throw new Error(`fatal: ${command}`);
  };
}

/** A Hive home with the shipped plugin, one custom version, a folder per experiment, and git answering `files` at SHA; the dispatch reduces. */
export async function benchDeps(t: TestContext, opts: BenchOpts = {}): Promise<BenchDeps> {
  const [home, pluginSource, repo] = await Promise.all(['bench-home-', 'bench-plugin-', 'bench-repo-'].map((prefix) => tempDir(t, prefix)));
  await put(pluginSource, PLUGIN_FILES);
  await put(home, CUSTOM_FILES);
  for (const e of opts.experiments ?? []) await put(join(home, 'benchmark', e.id), FOLDER_FILES);
  let state = stateWith(...(opts.experiments ?? []));
  const events: BenchmarkEvent[] = [];
  const calls: string[][] = [];
  const git = fakeGit(opts.files ?? {});
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    return { stdout: git(args.slice(2)) };
  };
  const { log, lines } = fakeLog();
  const config = benchConfig(repo);
  const deps: DraftDeps = {
    dispatch: async (event) => { events.push(event); state = benchmarkReduce(state, event); },
    home, pluginSource, exec, version: async () => '0.1.0', now: () => new Date(AT),
  };
  return {
    home, pluginSource, repo, calls, lines, log, config, events, deps, state: () => state,
    ctx: () => ({ deps, config, experiments: state.benchmark.experiments }), dir: (id) => join(home, 'benchmark', id),
  };
}

export async function serve(t: TestContext, opts: BenchOpts = {}): Promise<Bench> {
  const bench = await benchDeps(t, opts);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const live = () => ({ runtime: { config: bench.config }, state: bench.state() });
  registerBenchmarkRoutes(app, {
    ...bench.deps, requireLive: live, getLive: live, log: bench.log,
    runner: { run: async () => 'started', sleep: async () => undefined, wake: async () => undefined, isLive: () => false, blindness: async () => undefined },
    evaluator: { evaluate: async () => undefined, isEvaluating: () => false, abortAll: async () => undefined },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { ...bench, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function call(bench: Bench, method: string, path: string, body?: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${bench.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return [res.status, res.status === 204 ? undefined : await res.json()];
}
export const errorOf = ([status, body]: [number, unknown]): [number, string] => [status, (body as { error: string }).error];
