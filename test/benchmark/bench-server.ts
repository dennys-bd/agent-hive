import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import express from 'express';
import { benchmarkReduce } from '../../src/benchmark-reducer.js';
import { registerBenchmarkRoutes } from '../../src/server-benchmark.js';
import type { BenchmarkEvent, Exec, Experiment, State } from '../../src/types.js';
import { put } from '../custom-fixture.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';
import { benchConfig, SHA, stateWith } from './fixtures.js';

export const AT = '2026-10-21T12:00:00.000Z';
export const PLUGIN_FILES = { '.claude-plugin/plugin.json': '{"name":"hive","version":"0.1.0"}', 'skills/new-build/SKILL.md': 'ship\n' };
export const CUSTOM_FILES = { 'custom/hive/new-build/tdd/version.json': JSON.stringify({ name: 'tdd', from: 'original', workspaces: ['bench'] }), 'custom/hive/new-build/tdd/files/SKILL.md': 'tdd\n' };
// The folder of an experiment the state already holds: a pin, a seed, and a round's leftovers that no copy may carry
export const FOLDER_FILES = { 'plugin/source/skills/new-build/SKILL.md': 'pinned\n', 'plugin/custom/hive/new-build/tdd/version.json': '{}', 'seed/scenarios.md': '', 'seed/upload/old.txt': 'old\n', 'runs/aaaa1/hive.log': 'x' };

export interface Bench { base: string; home: string; repo: string; calls: string[][]; lines: string[]; state(): State; dir(id: string): string }

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

export async function serve(t: TestContext, opts: { experiments?: Experiment[]; files?: Record<string, string> } = {}): Promise<Bench> {
  const [home, pluginSource, repo] = await Promise.all(['bench-home-', 'bench-plugin-', 'bench-repo-'].map((prefix) => tempDir(t, prefix)));
  await put(pluginSource, PLUGIN_FILES);
  await put(home, CUSTOM_FILES);
  for (const e of opts.experiments ?? []) await put(join(home, 'benchmark', e.id), FOLDER_FILES);
  let state = stateWith(...(opts.experiments ?? []));
  const calls: string[][] = [];
  const git = fakeGit(opts.files ?? {});
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    return { stdout: git(args.slice(2)) };
  };
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerBenchmarkRoutes(app, {
    requireLive: () => ({ runtime: { config: benchConfig(repo) }, state }),
    getLive: () => ({ runtime: { config: benchConfig(repo) }, state }),
    dispatch: async (event: BenchmarkEvent) => { state = benchmarkReduce(state, event); },
    home, pluginSource, exec, log, version: async () => '0.1.0', now: () => new Date(AT),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, repo, calls, lines, state: () => state, dir: (id) => join(home, 'benchmark', id) };
}

export async function call(bench: Bench, method: string, path: string, body?: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${bench.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return [res.status, res.status === 204 ? undefined : await res.json()];
}
export const errorOf = ([status, body]: [number, unknown]): [number, string] => [status, (body as { error: string }).error];
