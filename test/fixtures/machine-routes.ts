import type { TestContext } from 'node:test';
import type { Dirent, Stats } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { type Machine, MachineError, type MachineFs, pathsOf } from '../../src/machine.js';
import { initialState } from '../../src/orchestrator.js';
import { registerEditorRoutes } from '../../src/server-editor.js';
import { registerFileBaseRoutes } from '../../src/server-file-base.js';
import type { TaskRouteDeps } from '../../src/server-tasks.js';
import { registerTreeRoutes } from '../../src/server-tree.js';
import { type CombConfig, type Exec, LOCAL_MACHINE, type State, type Task } from '../../src/types.js';
import { fakeMachine, statsOf } from '../fake-machine.js';
import { activityIdOf, withWork } from './work.js';

// The tree, editor and file-base routes alone (#929) on a fake machine of `platform`, whatever the host. One task's local run, whose root is
// its workspace's path as written: a worktree's would go through worktree.ts' host join, 1.2's. The disk holds docs/agent/a.md and an empty
// folder, nothing holds .git; every fs path and git argv is recorded.
export const ROUTE_SHA = 'abc123';
const TEXT = '# a';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive' };

export interface MachineRoutes { base: string; at(...parts: string[]): string; fsCalls: string[]; gitCalls: string[][] }

/** Whether `path` is absolute in `platform`'s flavour alone: posix `/…` with no `\`, win32 `C:\…` with no `/`. */
export const isFlavoured = (path: string, platform: NodeJS.Platform): boolean =>
  (platform === 'win32' ? /^[A-Z]:\\/.test(path) && !path.includes('/') : path.startsWith('/') && !path.includes('\\'));

function recordingFs(root: string, paths: Machine['paths'], calls: string[]): Partial<MachineFs> {
  const folders = new Set([root, paths.join(root, 'docs'), paths.join(root, 'docs', 'agent'), paths.join(root, 'empty')]);
  const files = new Set([paths.join(root, 'docs', 'agent', 'a.md')]);
  const seen = (path: string): string => {
    calls.push(path);
    if (!folders.has(path) && !files.has(path)) throw new MachineError(`ENOENT: ${path}`, { code: 'ENOENT' });
    return path;
  };
  const stat = async (path: string): Promise<Stats> => statsOf(folders.has(seen(path)) ? 'folder' : 'file');
  const children = (folder: string): Dirent[] => [...folders, ...files].filter((p) => p !== folder && paths.dirname(p) === folder)
    .map((p) => ({ name: paths.basename(p), isDirectory: () => folders.has(p) }) as unknown as Dirent);
  return {
    stat, lstat: stat as MachineFs['lstat'],
    realpath: async (path) => seen(path),
    access: async (path) => { seen(path); },
    readdir: (async (path: string) => children(seen(path))) as unknown as MachineFs['readdir'],
    readFile: (async (path: string) => { seen(path); return Buffer.from(TEXT); }) as unknown as MachineFs['readFile'],
  };
}

// git as the routes meet it: the tree's listings, the file's toplevel, HEAD's sha; a blob lookup answers nothing (an untracked file)
const fakeGit = (root: string, calls: string[][]): Exec => async (_file, args) => {
  calls.push(args);
  if (args.includes('--show-toplevel')) return { stdout: `${root}\n` };
  if (args.includes('--directory')) return { stdout: 'empty/\0' };
  if (args.includes('ls-files')) return { stdout: 'docs/agent/a.md\0' };
  if (args.some((arg) => arg.endsWith('^{commit}'))) return { stdout: `${ROUTE_SHA}\n` };
  return { stdout: '' };
};

export async function startMachineRoutes(t: TestContext, platform: NodeJS.Platform): Promise<MachineRoutes> {
  const paths = pathsOf(platform);
  const root = platform === 'win32' ? 'C:\\repo' : '/repo';
  const fsCalls: string[] = [];
  const gitCalls: string[][] = [];
  const exec = fakeGit(root, gitCalls);
  const machine = fakeMachine({ exec, fs: recordingFs(root, paths, fsCalls), info: { platform } });
  const comb: CombConfig = {
    prefix: 'HIVE', workspaces: [{ name: 'hive', path: root, machine: LOCAL_MACHINE, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }],
    sources: [], flows: [], commands: [], hiveSource: true, createIn: 'hive',
  };
  const state: State = withWork({ ...initialState(0), tasks: [TASK] }, TASK.item.itemId, { local: true, worktree: root });
  const requireLive = (() => ({ state, runtime: { config: { comb } } })) as unknown as TaskRouteDeps['requireLive'];
  const machineFor = (): Machine => machine;
  const app = express();
  registerTreeRoutes(app, { exec, requireLive, machineFor, treeWatch: { watchNested: async () => undefined } as unknown as TaskRouteDeps['treeWatch'] });
  registerEditorRoutes(app, { requireLive, machineFor, consoleStore: {} as TaskRouteDeps['consoleStore'] });
  registerFileBaseRoutes(app, { requireLive, machineFor });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activities/${encodeURIComponent(activityIdOf(TASK.item.itemId))}`;
  return { base, at: (...parts) => paths.join(root, ...parts), fsCalls, gitCalls };
}
