import { execFile } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  ARCHIVE_ITEM, CLOSE_ISSUE, COMMENTS, DELETE_ISSUE, DELETE_ITEM, ISSUE_ID, ITEMS, PROJECTS, PROJECT_FIELDS, PROJECT_ITEMS, SELECT_FIELDS, SET_OPTION, REPOSITORY_ID, CREATE_ISSUE, ADD_PROJECT_ITEM, VIEWER,
} from '../src/sources/github-queries.js';
import { type LegacyStage, stripLegacy, transitionsOf } from '../src/config-migrate.js';
import { citedColumns, onSource } from '../src/tasks.js';
import { initialState } from '../src/orchestrator.js';
import { saveState } from '../src/state-store.js';
import type { Logger } from '../src/log.js';
import type { GqlJson } from '../src/sources/github-gql.js';
import type { EventLog, RecordInput } from '../src/events.js';
import type { Pty, PtySpawnOptions, SpawnPty } from '../src/pty-host.js';
import type { Source, SourceConfig, SourceTaskProps, SourceQuota, SourceSpec, TaskFilter, Stage, Transition, Gql, ItemAction, MoveAction, Workspace, SpawnOptions, LaunchPty, PtyHandlers, PtyLaunch } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { tempDir, type AfterHost } from './temp-dir.js';

export interface FakeWorker {
  launch: PtyLaunch;
  handlers: PtyHandlers;
  options?: SpawnOptions; // the third argument the server passed: how a test reaches the server's pty host
  killed: number;
  releaseKill(): void; // with holdKills: resolves the pending kill() and makes later kills resolve at once (the process is gone)
}

export interface FakeSpawnOptions {
  startError?: string; // every worker's `started` rejects with it, like a pty that would not spawn
  holdKills?: boolean; // kill() stays pending until releaseKill(): what the awaited-kill tests need
  neverStarts?: boolean; // every worker's `started` stays pending, like a Linux terminal that only settles when its window closes (#249)
}

function fakeStarted({ startError, neverStarts }: FakeSpawnOptions): Promise<void> {
  if (neverStarts) return new Promise<void>(() => {});
  return startError === undefined ? Promise.resolve() : Promise.reject(new Error(startError));
}

/** A LaunchPty that opens nothing: records every call and exposes the handlers so a test can report errors and exits. */
export function fakeSpawn(options: FakeSpawnOptions = {}): { spawn: LaunchPty; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: LaunchPty = (launch, handlers, spawnOptions) => {
    let released = false;
    const pending: (() => void)[] = [];
    const worker: FakeWorker = {
      launch, handlers, options: spawnOptions, killed: 0,
      releaseKill: () => {
        released = true;
        for (const resolve of pending.splice(0)) resolve();
      },
    };
    workers.push(worker);
    return {
      started: fakeStarted(options),
      kill: () => {
        worker.killed += 1;
        if (!options.holdKills || released) return Promise.resolve();
        return new Promise<void>((resolve) => { pending.push(resolve); });
      },
    };
  };
  return { spawn, workers };
}

export const LAUNCH: PtyLaunch = {
  ptyId: 'W1', slug: 'hive-1-task', cwd: '/repo/.hive/worktrees/hive-1-task', port: 4242,
  hooksPath: '/repo/.hive/hooks.json', pluginDir: '/home/agent-hive/plugin', mcpPath: '/repo/.hive/prompts/W1.mcp.json', promptPath: '/repo/.hive/prompts/hive-1-task.md',
  args: ['--session-id', 'a1b2c3d4-0000-4000-8000-000000000001'],
};

export const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];

/** What every config fixture carries now that `auth` is required: the transport the tests never exercise. */
export const AUTH = { github: 'cli' } as const;

/** What every github source fixture carries now that `filter` is a required list of rules (#245): no restriction, today's behaviour. */
export const FILTER: TaskFilter = [];

/** A Response with a JSON body: what a fake fetch answers with, in both node:test and vitest. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Which query it is: the constants are compared by identity, the relations query is built per poll and matched by its shape. */
function queryName(query: string): string {
  if (query === PROJECTS) return 'projects';
  if (query === PROJECT_FIELDS) return 'fields';
  if (query === SELECT_FIELDS) return 'selectFields';
  if (query === ITEMS) return 'items';
  if (query === PROJECT_ITEMS) return 'projectItems';
  if (query === SET_OPTION) return 'setOption';
  if (query === COMMENTS) return 'comments';
  if (query === VIEWER) return 'viewer';
  if (query === ARCHIVE_ITEM) return 'archiveItem';
  if (query === DELETE_ITEM) return 'deleteItem';
  if (query === CLOSE_ISSUE) return 'closeIssue';
  if (query === DELETE_ISSUE) return 'deleteIssue';
  if (query === ISSUE_ID) return 'issueId';
  if (query === REPOSITORY_ID) return 'repositoryId';
  if (query === CREATE_ISSUE) return 'createIssue';
  if (query === ADD_PROJECT_ITEM) return 'addProjectItem';
  return query.includes('blockedBy(') ? 'relations' : 'unknown';
}

export interface GqlCall { name: string; query: string; variables?: Record<string, string | number | boolean> }

/**
 * A Gql that runs nothing: `responses` is keyed by query name and holds the `data` to answer with. An array value is a queue,
 * one entry per successive call of that query — what a two-page `items` response needs. An unknown key rejects, like a failed call.
 */
export function fakeGql(responses: Record<string, unknown>): { calls: GqlCall[]; gql: Gql } {
  const calls: GqlCall[] = [];
  const queues: Record<string, unknown> = { ...responses };
  const gql: Gql = async (query, variables) => {
    const name = queryName(query);
    calls.push({ name, query, variables });
    if (!(name in queues)) throw new Error(`unexpected graphql call: ${name}`);
    const value = queues[name];
    return Array.isArray(value) ? (value as unknown[]).shift() : value;
  };
  return { calls, gql };
}

export interface JsonCall { query: string; variables: Record<string, unknown> }

/** A GqlJson that runs nothing (#757): `answer` maps each call to its data, a throw is GitHub's refusal; every call is recorded. */
export function fakeGqlJson(answer: (query: string, variables: Record<string, unknown>) => unknown): { calls: JsonCall[]; gql: GqlJson } {
  const calls: JsonCall[] = [];
  const gql: GqlJson = async (query, variables) => {
    calls.push({ query, variables });
    return answer(query, variables);
  };
  return { calls, gql };
}

/** The name every single-source fixture gives its source (#180): what the server namespaces its items with (`board:I1`). */
export const SOURCE = 'board';
/** Every source fixture's task properties (#688): every property fixed, the workspace on WORKSPACE ('hive'), the Comb's one workspace, and auto on. */
export const FIXED: SourceTaskProps = { defaults: { workspace: 'hive', auto: true }, rules: [] };
/** A comb.sources entry named SOURCE around a source's fields, ids unqualified: today's single source, as a raw config value. */
export const sourceEntry = (fields: Record<string, unknown>): Record<string, unknown> => ({ name: SOURCE, qualifyId: false, taskProps: FIXED, ...fields });
/** The epics keys every GitHub source fixture carries (#30): a new source's mode and follows, switchAt on STAGES' one stage. combConfig gives
 * them to every GitHub entry, switchAt on the fixture's own first stage; a key the entry sets wins, undefined included. */
export const EPICS = { epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' } as const;
/** The GitHub source every setup body fixture sends. */
export const GITHUB_ENTRY: SourceConfig = { name: SOURCE, qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS };

/** A move to `column` (#286): what every onStart and most onFinish entries are. */
export const move = (column: string): MoveAction => ({ type: 'move', column });

/** One stage that reproduces today's flow on SOURCE: Ready → In progress on start → In review on finish, then the task leaves. */
export const STAGES: LegacyStage[] = [
  { name: 'fila', from: { [SOURCE]: ['Ready'] }, onStart: { [SOURCE]: [move('In progress')] }, onFinish: { [SOURCE]: [move('In review')] }, prompt: 'Task #{id}: {title}\n\n{body}' },
];

/** Stages for a Comb without a source: nothing enters from a source column, nothing is written to one. */
export const LOCAL_STAGES: Stage[] = [{ name: 'fila', from: {}, prompt: 'Task {id}: {title}\n\n{body}' }];

/** The name every single-workspace fixture gives its workspace (#179): what a task resolves to through the Comb's only workspace. */
export const WORKSPACE = 'hive';
/** The `workspaces` a setup body sends for a Comb with one workspace at `path`. */
export const workspacesAt = (path: string): Workspace[] => [{ name: WORKSPACE, path, env: {}, fork: null, memoryCap: 4000 }]; // no env (#348); run commands live in comb.commands (#511)

// #134: the migration's transitions over a fixture's stages, when they are stages at all; a malformed list is the parser's to name
const derivedFlow = (stages: unknown): Transition[] =>
  (Array.isArray(stages) && stages.every((s) => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string') ? transitionsOf(stages as LegacyStage[]) : []);

// #30: the name of a fixture's first stage, what a GitHub entry without switchAt switches at; STAGES' own when the list is not one
const firstStage = (stages: unknown): string => {
  const first: unknown = Array.isArray(stages) ? stages[0] : undefined;
  return typeof first === 'object' && first !== null && typeof (first as { name?: unknown }).name === 'string' ? (first as { name: string }).name : EPICS.switchAt;
};
// #30: a GitHub entry gets the epics keys it lacks, so a fixture with its own flow still parses; anything else is left for the parser to name
const withEpics = (stages: unknown) => (entry: unknown): unknown =>
  (typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'github' ? { ...EPICS, switchAt: firstStage(stages), ...entry } : entry);

/** A setup body whose sources switch at one of its own stages (#30): a source whose switchAt names none takes the first. What a server test posts
 * with its own flow, so the switchAt check config.test covers never trips an unrelated test. */
export function onOwnStages<T extends { sources?: SourceConfig[]; stages?: readonly { name: string }[] }>(body: T): T {
  const names = (body.stages ?? []).map((s) => s.name);
  if (names.length === 0 || body.sources === undefined) return body;
  return { ...body, sources: body.sources.map((s) => (names.includes(s.switchAt) ? s : { ...s, switchAt: names[0] })) };
}

/**
 * A raw hive.config.json around a Comb: `prefix` (HIVE), one workspace at `path` (/repo), `sources` ([] unless given; `board` is shorthand for
 * one entry named SOURCE), `stages` (STAGES). Every other key lands at the top level, `auth` included: AUTH unless the caller passes its
 * own (`auth: undefined` leaves it out of the parse). The viewer settings are the form defaults unless the caller passes its own
 * (`onClose: undefined` writes a file from before the key (#513); `deleteActivity: undefined` one from before #236;
 * `shutdownIdleMinutes: undefined` one from before #233; `theme: undefined` one from before #296; `terminalFont: undefined` one from before #376;
 * `trustedDomains: undefined` one from before #404; `consoleLines: undefined` one from before #353; `shortcuts: undefined` one from before #449; `closeSessionTab: undefined` one from before #614);
 * Every GitHub entry gets EPICS' keys it lacks, switchAt on the first of `stages` (#30).
 * `commands` is comb.commands ([] unless given, #511). `transitions` is comb.transitions, the migration's over `stages` unless given (#134). A workspace without env is a file from before #348. `editor` is EDITOR_DEFAULTS (#780); `editor: undefined` writes a file without it. `sidebarsPerView: undefined` writes a file from before #821. `signals: undefined` writes a file from before #727. `notifications: undefined` writes a file from before #199.
 */
export function combConfig({
  source, sources = source === undefined ? [] : [sourceEntry(source as Record<string, unknown>)], stages = STAGES, transitions, prefix = 'HIVE', path = '/repo',
  workspaces = [{ name: WORKSPACE, path, env: {}, fork: null, memoryCap: 4000 }], commands = [], hiveSource = true, createIn = 'hive', ...rest
}: Record<string, unknown> = {}): Record<string, unknown> {
  return { auth: AUTH, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: true }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, ...rest, comb: { prefix, workspaces, sources: Array.isArray(sources) ? sources.map(withEpics(stages)) : sources, stages, transitions: transitions ?? derivedFlow(stages), commands, hiveSource, createIn } };
}

/** A pre-#134 stage list, onFinish and all, as the flow its migration makes (#134): what a reducer fixture spreads where it set `stages`. */
export const chained = (stages: readonly LegacyStage[]): { stages: Stage[]; transitions: Transition[] } =>
  ({ stages: stages.map(stripLegacy), transitions: transitionsOf(stages) });

// A source that has the OPTIONS columns and returns one task named after the configured entry column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap; `quota` gives it a fixed quota reading (none by default);
// `applyError` makes every source action reject with that message (#286). `applied` records each action as `<own id> <type>`; `actions` the same calls whole (#314).
export function fakeSourceFactory(resolveDelayMs = 0, quota?: SourceQuota, applyError?: string): { factory: (config: SourceSpec) => Source; configs: SourceSpec[]; applied: string[]; actions: ItemAction[] } {
  const configs: SourceSpec[] = [];
  const applied: string[] = [];
  const actions: ItemAction[] = []; // the whole action, reason included (#314)
  const factory = (config: SourceSpec): Source => {
    configs.push(config);
    return {
      async resolveFields() {
        if (resolveDelayMs > 0) await sleep(resolveDelayMs);
        for (const { column, by } of citedColumns(config.stages, config.transitions, config.source.name)) {
          if (!OPTIONS.includes(column)) throw new Error(`"${column}" (${by}) not found in source Status options: ${OPTIONS.join(', ')}`);
        }
      },
      async listItems() {
        const from = config.stages.flatMap((c) => onSource(c.from, config.source.name) ?? [])[0];
        return [{ item: { itemId: 'I1', id: '1', title: `from ${from}`, body: '', url: 'https://github.com/acme/r/issues/1' }, column: from }];
      },
      async setColumn() {},
      async apply(itemId, action) {
        applied.push(`${itemId} ${action.type}`);
        actions.push(action);
        if (applyError !== undefined) throw new Error(applyError);
      },
      async settingsOptions() {
        return OPTIONS;
      },
      ...(quota ? { quota: async () => quota } : {}),
    };
  };
  return { factory, configs, applied, actions };
}

/** A Logger that writes nothing: every call becomes a `LEVEL message` line, whatever the level, and setLevel a `LEVEL <level>` line. */
export function fakeLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (tag: string) => (message: string): void => {
    lines.push(`${tag} ${message}`);
  };
  return { lines, log: { error: at('ERROR'), record: (level, message) => at(level.toUpperCase())(message), warn: at('WARN'), info: at('INFO'), debug: at('DEBUG'), setLevel: at('LEVEL') } };
}

/** An EventLog that keeps every record it is given, whatever its level (#742). */
export function fakeEvents(): { events: EventLog; records: RecordInput[] } {
  const records: RecordInput[] = [];
  return { records, events: { write: (record) => { records.push(record); }, setLevel: () => undefined } };
}

/** Reserves a free localhost port and releases it at once: the caller binds it right after. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error('no free port')) : resolvePromise(port)));
    });
  });
}

/** A fresh Hive's two folders, both removed after the test (#428): an empty home for its own files and a `git init` repo for its workspace.
 * POST /settings checks the workspace with the real git (`rev-parse --show-toplevel` must answer the folder itself), so a bare temp dir is not
 * enough. `cap` is the state's worker cap: 0 by default, so a test whose fake source has a task never starts a real claude. */
export async function tempHive(t: AfterHost, cap = 0): Promise<{ home: string; repo: string }> {
  const home = await tempDir(t, 'home-');
  await saveState(home, initialState(cap)); // #727: the cap left the config; a server test's first boot reads it from here, and 0 spawns nothing
  const repo = await tempDir(t, 'repo-');
  await promisify(execFile)('git', ['init', '--quiet', repo]);
  return { home, repo };
}

/** A pty that runs nothing (#251): records what reaches it; the test drives its output and its exit. */
export interface FakePty extends Pty {
  file: string;
  args: string[];
  options: PtySpawnOptions;
  written: string[];
  sizes: [number, number][];
  killed: number;
  emit(data: string): void;
  exit(exitCode?: number): void;
}

/** A SpawnPty that opens nothing: every pty it hands out lands in `ptys`, in spawn order. */
export function fakePtys(): { spawnPty: SpawnPty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawnPty: SpawnPty = (file, args, options) => {
    const onData: ((data: string) => void)[] = [];
    const onExit: ((event: { exitCode: number }) => void)[] = [];
    const pty: FakePty = {
      pid: 4000 + ptys.length, // #696: the first pty is 4000
      file, args, options, written: [], sizes: [], killed: 0,
      onData: (listener) => { onData.push(listener); },
      onExit: (listener) => { onExit.push(listener); },
      write: (data) => { pty.written.push(data); },
      resize: (cols, rows) => { pty.sizes.push([cols, rows]); },
      kill: () => { pty.killed += 1; },
      emit: (data) => { for (const listener of onData) listener(data); },
      exit: (exitCode = 0) => { for (const listener of onExit) listener({ exitCode }); },
    };
    ptys.push(pty);
    return pty;
  };
  return { spawnPty, ptys };
}
