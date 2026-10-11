import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, taskOfWorker } from '../src/activities.js';
import { readyOn } from './fixtures/work.js';
import { CONFIG_FILE, parseConfig } from '../src/config.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { renamesRefusal } from '../src/settings-save.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Source, SourceItem, SourceSpec, Task, Config, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, combConfig, EPICS, FILTER, FIXED, fakeLog, fakeSpawn, LOCAL_STAGES, move, OPTIONS, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { noCreateMessage, notInFlowNotice } from '../src/create-task.js';

// Several sources per Comb (#180): two GitHub-shaped sources, `work` (project 6) and `notes` (project NOTES_PROJECT), both fakes a test fills,
// breaks and reads the writes of. The fakes list raw ids; the server namespaces them (`work:12`), as it does a real adapter.
interface FakeSource { listed: SourceItem[]; failure?: string; writes: string[]; built: number; made: number; hidden?: boolean } // writes: `id→column` moves, `id type` actions
interface Sources { base: string; home: string; server: HiveServer; work: FakeSource; notes: FakeSource; body: SettingsBody; lines: string[] }

const STAGES: LegacyStage[] = [
  { name: 'dev', from: { work: ['Ready'], notes: ['Ready'] }, onStart: { work: [move('In progress')], notes: [move('In progress')] }, prompt: 'x' },
];
const NOTES_PROJECT = 8; // the second source's project; a save that renumbers work (#278) never reaches it
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const listing = (id: string, title = `Task ${id}`): SourceItem => ({ item: { itemId: id, id, title, body: '', url: '' }, column: 'Ready' });

async function startSources(t: TestContext, maxConcurrent = 0, qualifyNotes = true, stages = STAGES): Promise<Sources> {
  const { home, repo } = await tempHive(t, maxConcurrent);
  const fakes: Record<string, FakeSource> = { work: { listed: [], writes: [], built: 0, made: 0 }, notes: { listed: [], writes: [], built: 0, made: 0 } };
  const sourceFactory = (spec: SourceSpec): Source => {
    const fake = fakes[spec.source.type === 'github' && spec.source.number === NOTES_PROJECT ? 'notes' : 'work']; // by project (#278): a renamed entry keeps listing the same source
    fake.built += 1;
    return {
      resolveFields: async () => {}, settingsOptions: async () => OPTIONS,
      listItems: async () => {
        if (fake.failure) throw new Error(fake.failure);
        return [...fake.listed];
      },
      setColumn: async (itemId, column) => { fake.writes.push(`${itemId}→${column}`); },
      apply: async (itemId, action) => { fake.writes.push(`${itemId} ${action.type}`); },
      create: async ({ title, column }) => { fake.made += 1; const id = String(100 + fake.made); fake.writes.push(`create ${title}→${column}`); if (!fake.hidden) fake.listed.push(listing(id, title)); return id; },
    };
  };
  const { log, lines } = fakeLog();
  const server = createServer({ secret: SECRET, home, sourceFactory, launchPty: fakeSpawn().spawn, log, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = {
    prefix: 'HIVE', auth: AUTH, workspaces: workspacesAt(repo), stages, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
    shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
    sources: [
      { name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS, switchAt: stages[0].name },
      { name: 'notes', qualifyId: qualifyNotes, type: 'github', owner: 'acme', number: NOTES_PROJECT, filter: FILTER, taskProps: FIXED, ...EPICS, switchAt: stages[0].name },
    ],
  };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  await server.poll(); // the save's own poll runs in the background (#59): settle it on the empty listings
  return { base, home, server, work: fakes.work, notes: fakes.notes, body, lines };
}

test('each task is written on its own source with the adapter\'s own id; qualifyId shows notes-12 beside work\'s 12 (#180)', async (t) => {
  const sources = await startSources(t, 2);
  sources.work.listed.push(listing('12'));
  sources.notes.listed.push(listing('12'));
  await sources.server.dispatch({ type: 'setSignal', signal: 'green' });
  await sources.server.poll();
  const tasks = sources.server.getState()?.tasks.map((c) => `${c.item.itemId}=${c.item.id}`).sort();
  assert.deepEqual(tasks, ['notes:12=notes-12', 'work:12=12']);
  assert.deepEqual([sources.work.writes, sources.notes.writes], [['12→In progress'], ['12→In progress']]);
});

test('one save, two sources: each source\'s start and finish lists reach its own adapter in order (#515)', async (t) => {
  const stages: LegacyStage[] = [{
    name: 'dev', from: { work: ['Ready'], notes: ['Ready'] }, prompt: 'x',
    onStart: { work: [move('In progress')] }, onFinish: { work: [move('In review'), { type: 'close' }], notes: [{ type: 'remove' }] },
  }];
  const sources = await startSources(t, 2, true, stages);
  sources.work.listed.push(listing('12'));
  sources.notes.listed.push(listing('13'));
  await sources.server.dispatch({ type: 'setSignal', signal: 'green' });
  await sources.server.poll();
  for (const taskId of ['work:12', 'notes:13']) {
    const current = sources.server.getState()!;
    const ptyId = current.workers.find((s) => taskOfWorker(current, s)?.item.itemId === taskId)!.runId!;
    await sources.server.dispatch({ type: 'done', ptyId });
    await sources.server.dispatch({ type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
  }
  assert.deepEqual(sources.work.writes, ['12→In progress', '12→In review', '12 close']);
  assert.deepEqual(sources.notes.writes, ['13 remove']);
  assert.deepEqual(sources.server.getState()!.tasks.map((c) => c.item.itemId), [], 'work ended its last stage; notes left once the remove succeeded');
});

test('a save that changes one source builds only that one again: the other keeps its instance (#180)', async (t) => {
  const sources = await startSources(t);
  assert.deepEqual([sources.work.built, sources.notes.built], [1, 1]);
  const [work, notes] = sources.body.sources ?? [];
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [{ ...work, number: 7 }, notes] })).status, 200);
  assert.deepEqual([sources.work.built, sources.notes.built], [2, 1]);
});

test('a source that fails its poll keeps the error on its own status and in the log while the other source\'s tasks still land (#180)', async (t) => {
  const sources = await startSources(t);
  sources.notes.failure = 'project 8 is gone';
  sources.work.listed.push(listing('12'));
  await sources.server.poll();
  const state = sources.server.getState();
  assert.deepEqual(state?.tasks.map((c) => c.item.itemId), ['work:12']);
  assert.equal(state?.syncs.notes.error, 'project 8 is gone');
  assert.equal(state?.syncs.work.error, undefined);
  assert.ok(sources.lines.includes('ERROR source notes: project 8 is gone'), sources.lines.join('\n'));
});

test('POST /tasks/:id/open answers 409 when another task of the same workspace owns the slug, before any worktree (#180, #237)', async (t) => {
  const sources = await startSources(t, 0, false); // notes unqualified: both sources list id 12 titled "Same", one slug
  sources.work.listed.push(listing('12', 'Same'));
  sources.notes.listed.push(listing('12', 'Same'));
  await sources.server.poll();
  await readyOn(sources.server, 'work:12', { path: '/w', branch: 'hive/12-same', base: null, local: false }); // #629: the first open's createActivity first
  await sources.server.dispatch({ type: 'setAuto', taskId: 'notes:12', auto: false });
  const res = await postJson(`${sources.base}/tasks/notes:12/open`, { kind: 'claude' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'slug hive-12-same is used by 12' });
});

test('renamesRefusal (#278): 400 for a map the running Hive cannot apply, 409 when a task of a removed source still carries the new name; a swap goes through; an omitted map or no live Hive renames nothing', () => {
  // Each source needs a stage with a "from" entry naming it (parseColumns), unlike LOCAL_STAGES' sourceless one (#278 deviation: adapted to the real fixture).
  const configOf = (...names: string[]): Config =>
    parseConfig(combConfig({
      sources: names.map((name, i) => ({ name, qualifyId: false, type: 'github', owner: 'acme', number: i + 1, filter: FILTER, taskProps: FIXED })),
      stages: [{ ...LOCAL_STAGES[0], from: Object.fromEntries(names.map((name) => [name, ['Ready']])) }],
    }));
  const on = (board: string, n: number, extra: Partial<Task> = {}): Task =>
    ({ item: { itemId: `${board}:${n}`, id: String(n), title: `Task ${n}`, body: '', url: '', source: board }, stage: 'fila', boardColumn: 'Ready', auto: true, ...extra });
  const live = { config: configOf('work', 'notes'), state: { ...initialState(0), tasks: [on('work', 1), on('old', 2, { missing: true })] } }; // old: removed by an earlier save
  const next = configOf('job', 'notes');
  const bad = (renames: unknown, config: Config, message: string): void =>
    assert.deepEqual(renamesRefusal(renames, config, live), { status: 400, message }, JSON.stringify(renames));
  bad(['work'], next, 'renames must map source names to source names');
  bad({ work: 3 }, next, 'renames must map source names to source names');
  bad({ gone: 'job' }, next, 'renames: gone is not a source of the running Hive');
  bad({ work: 'job' }, configOf('work', 'job', 'notes'), 'renames: work is still a source of this config');
  bad({ work: 'nope' }, next, 'renames: nope is not a source of this config');
  bad({ work: 'job', notes: 'job' }, configOf('job'), 'renames: work and notes both rename to job');
  assert.deepEqual(renamesRefusal({ work: 'old' }, configOf('old', 'notes'), live), { status: 409, message: 'source old is still used by 1 tasks of a removed source: close them first' });
  assert.equal(renamesRefusal({ work: 'job' }, next, live), undefined);
  assert.equal(renamesRefusal({ work: 'notes', notes: 'work' }, configOf('notes', 'work'), live), undefined, 'a swap: every task of both names is rewritten');
  assert.equal(renamesRefusal(undefined, next, live), undefined, 'an API caller that omits it renames nothing');
  assert.equal(renamesRefusal({ gone: 'x' }, next, undefined), undefined, 'a first setup: no tasks to carry');
});

test('a save that renames a source carries its running task over: the same worktree, session, stage and worker under the new id, and the next poll neither loses nor duplicates it (#278)', async (t) => {
  const sources = await startSources(t, 1);
  sources.work.listed.push(listing('12'));
  await sources.server.dispatch({ type: 'setSignal', signal: 'green' });
  await sources.server.poll();
  const polled = sources.server.getState()!;
  const worker = polled.workers.find((s) => taskOfWorker(polled, s)?.item.itemId === 'work:12')!;
  await sources.server.dispatch({ type: 'hook', ptyId: worker.runId!, payload: { hook_event_name: 'SessionStart', cwd: '/w' } });
  const before = sources.server.getState()!.tasks.find((c) => c.item.itemId === 'work:12')!;
  const was = activityOf(sources.server.getState()!, 'work:12'); // #629: the worktree is the activity's
  assert.equal(was?.worktree, '/w');
  const [work, notes] = sources.body.sources ?? [];
  const renamed: SettingsBody = {
    ...sources.body, sources: [{ ...work, name: 'job' }, notes], renames: { work: 'job' },
    stages: [{ ...STAGES[0], from: { job: ['Ready'], notes: ['Ready'] }, onStart: { job: [move('In progress')], notes: [move('In progress')] } }],
  };
  assert.equal((await postJson(`${sources.base}/settings`, renamed)).status, 200);
  await sources.server.poll();
  const state = sources.server.getState()!;
  assert.deepEqual(state.tasks.map((c) => c.item.itemId), ['job:12'], 'no task missing, no duplicate');
  const [after] = state.tasks;
  // #629: the same activity, its sessionId and workerId with it; its record lists the new id
  assert.deepEqual([activityOf(state, 'job:12'), after.stage, after.missing], [was, before.stage, undefined], 'the same activity: its record lists the new id (#629)');
  assert.equal(taskOfWorker(state, state.workers.find((s) => s.id === worker.id)!)?.item.itemId, 'job:12', 'the worker keeps its activity, whose record lists the new id (#629)');
  assert.deepEqual(Object.keys(state.syncs).sort(), ['job', 'notes']);
});

test('a rename onto the name of a removed source whose task is still in the Hive is a 409 and writes nothing (#278)', async (t) => {
  const sources = await startSources(t);
  sources.notes.listed.push(listing('7'));
  await sources.server.poll();
  const [work] = sources.body.sources ?? [];
  const workOnly: LegacyStage[] = [{ ...STAGES[0], from: { work: ['Ready'] }, onStart: { work: [move('In progress')] } }];
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [work], stages: workOnly })).status, 200); // notes removed
  await sources.server.poll();
  assert.equal(sources.server.getState()?.tasks.find((c) => c.item.itemId === 'notes:7')?.missing, true, 'its board is gone');
  const saved = await readFile(join(sources.home, CONFIG_FILE), 'utf8');
  const res = await postJson(`${sources.base}/settings`, {
    ...sources.body, sources: [{ ...work, name: 'notes' }], renames: { work: 'notes' },
    stages: [{ ...STAGES[0], from: { notes: ['Ready'] }, onStart: { notes: [move('In progress')] } }],
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'source notes is still used by 1 tasks of a removed source: close them first' });
  assert.equal(await readFile(join(sources.home, CONFIG_FILE), 'utf8'), saved, 'hive.config.json untouched');
});

test('POST /tasks with a source creates the item in the stage\'s first column, polls that source and answers its task; a filtered item answers a notice (#846)', async (t) => {
  const sources = await startSources(t);
  const [work, notes] = sources.body.sources ?? [];
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [{ ...work, repository: 'acme/app' }, notes] })).status, 200);
  await sources.server.poll();
  const res = await postJson(`${sources.base}/tasks`, { title: 'Fix', stage: 'dev', source: 'work' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: '101', itemId: 'work:101' });
  assert.deepEqual(sources.work.writes, ['create Fix→Ready']);
  assert.ok(sources.server.getState()?.tasks.some((c) => c.item.itemId === 'work:101'), 'in the state when the answer arrives');
  sources.work.hidden = true;
  assert.deepEqual(await (await postJson(`${sources.base}/tasks`, { title: 'Hidden', stage: 'dev', source: 'work' })).json(), { itemId: 'work:102', notice: notInFlowNotice('work', 'work:102') });
  const refused = await postJson(`${sources.base}/tasks`, { title: 'x', stage: 'dev', source: 'notes' });
  assert.deepEqual([refused.status, await refused.json()], [400, { error: noCreateMessage('notes') }]);
});

test('a task the Start dialog creates on a source (auto false) enters the state with auto off, so the poll\'s fill leaves it for its creator; a plain create is born auto (#846)', async (t) => {
  const sources = await startSources(t, 2);
  const [work, notes] = sources.body.sources ?? [];
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [{ ...work, repository: 'acme/app' }, notes] })).status, 200);
  await sources.server.dispatch({ type: 'setSignal', signal: 'green' });
  await sources.server.poll();
  assert.equal((await postJson(`${sources.base}/tasks`, { title: 'Manual', stage: 'dev', source: 'work', auto: false })).status, 201);
  const manual = sources.server.getState()?.tasks.find((c) => c.item.itemId === 'work:101');
  assert.deepEqual([manual?.auto, sources.server.getState()?.workers.every((w) => w.status === 'empty')], [false, true], 'no worker took it');
  await sources.server.poll();
  assert.equal(sources.server.getState()?.tasks.find((c) => c.item.itemId === 'work:101')?.auto, false, 'a later poll leaves it');
  assert.equal((await postJson(`${sources.base}/tasks`, { title: 'Plain', stage: 'dev', source: 'work' })).status, 201);
  assert.equal(sources.server.getState()?.tasks.find((c) => c.item.itemId === 'work:102')?.auto, true);
});

test('an id the post-create poll did not list is forgotten: when the item shows up later it enters with auto on (#846)', async (t) => {
  const sources = await startSources(t, 2);
  const [work, notes] = sources.body.sources ?? [];
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [{ ...work, repository: 'acme/app' }, notes] })).status, 200);
  await sources.server.dispatch({ type: 'setSignal', signal: 'green' });
  sources.work.hidden = true;
  assert.equal((await postJson(`${sources.base}/tasks`, { title: 'Late', stage: 'dev', source: 'work', auto: false })).status, 201);
  sources.work.listed.push(listing('101', 'Late'));
  await sources.server.poll();
  assert.equal(sources.server.getState()?.tasks.find((c) => c.item.itemId === 'work:101')?.auto, true);
});

test('hive cannot be turned off while it holds a created task: 409 naming how many; once closed the save goes through (#846)', async (t) => {
  const sources = await startSources(t);
  const [work, notes] = sources.body.sources ?? [];
  const placed = { ...sources.body, language: 'en' as const, sources: [{ ...work, repository: 'acme/app' }, notes] };
  assert.equal((await postJson(`${sources.base}/settings`, placed)).status, 200);
  assert.equal((await postJson(`${sources.base}/tasks`, { title: 'Local', stage: 'dev' })).status, 201);
  const off = { ...placed, hiveSource: false, createIn: 'work' };
  const res = await postJson(`${sources.base}/settings`, off);
  assert.deepEqual([res.status, await res.json()], [409, { error: '1 tasks are still in hive; close them before turning it off' }]);
  assert.equal((await postJson(`${sources.base}/tasks/local%3A1/close`)).status, 200);
  assert.equal((await postJson(`${sources.base}/settings`, off)).status, 200);
  assert.equal(JSON.parse(await readFile(join(sources.home, CONFIG_FILE), 'utf8')).comb.hiveSource, false);
});

test('a save that renames the create-in source and omits createIn writes the new name (#846)', async (t) => {
  const sources = await startSources(t);
  const [work, notes] = sources.body.sources ?? [];
  const withRepo = { ...work, repository: 'acme/app' };
  assert.equal((await postJson(`${sources.base}/settings`, { ...sources.body, sources: [withRepo, notes], createIn: 'work' })).status, 200);
  const { createIn: _omitted, ...rest } = sources.body;
  const renamed = {
    ...rest, sources: [{ ...withRepo, name: 'job' }, notes], renames: { work: 'job' },
    stages: [{ ...STAGES[0], from: { job: ['Ready'], notes: ['Ready'] }, onStart: { job: [move('In progress')], notes: [move('In progress')] } }],
  };
  assert.equal((await postJson(`${sources.base}/settings`, renamed)).status, 200);
  assert.equal(JSON.parse(await readFile(join(sources.home, CONFIG_FILE), 'utf8')).comb.createIn, 'job');
});
