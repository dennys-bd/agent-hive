import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { localSessionsOf } from '../src/local-sessions.js';
import { sessionsOf, slugFor } from '../src/tasks.js';
import { activityOf, localActivityId, recordOf } from '../src/activities.js';
import { readyOn, workId, workPath } from './fixtures/work.js';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROMPTS_DIR, PROTOCOL_DIR } from '../src/hooks-settings.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Exec, OpenResult, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { transcriptDir } from '../src/usage.js';
import { worktreePath } from '../src/worktree.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, workspacesAt, STAGES, fakeSourceFactory, fakeSpawn, type FakeWorker, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';
import { NO_PROCESS_LIST } from './process-list.js';

// Copy (#587) end to end: the routes, the reducer and the pool's launch. maxConcurrent 0: every run below is a session the test opened.
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const getJson = (url: string): Promise<Response> => hiveFetch(url, { headers: { 'x-hive-ui': '1' } });
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}
const refused = async (res: Promise<Response>, status: number, error: string): Promise<void> => {
  const answer = await res;
  assert.deepEqual([answer.status, await answer.json()], [status, { error }]);
};
const TRANSCRIPT = [{ type: 'user', message: { content: 'hi' } }, { type: 'assistant', message: { id: 'm1', content: [] } }].map((l) => JSON.stringify(l)).join('\n');

function claudeConfigDir(t: TestContext, dir: string): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
}

interface Two { base: string; server: HiveServer; workers: FakeWorker[]; repo: string; home: string; git: string[][]; source: string; one: string; two: string; gate: Gate }
interface Gate { onGit?: () => Promise<void> } // runs inside the next git call: what changes while a route awaits git

// Two local activities in WORKSPACE, each with its worktree recorded; a session opened on the first and ended, its transcript written.
async function twoActivities(t: TestContext): Promise<Two> {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const git: string[][] = [];
  const gate: Gate = {};
  const exec: Exec = async (file, args) => {
    git.push([file, ...args]);
    const hook = gate.onGit;
    gate.onGit = undefined;
    await hook?.();
    return { stdout: args.includes('--show-current') ? 'feature/x\n' : args.includes('status') ? ' M a.ts\n?? b.ts\n' : '' };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec });
  const base = `http://127.0.0.1:${await server.listen(0)}`;
  t.after(() => server.close());
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  for (const title of ['one', 'two']) await server.dispatch({ type: 'createTask', title, body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  for (const c of server.getState()!.tasks) await readyOn(server, c.item.itemId, { path: worktreePath(repo, slugFor(c.item)), branch: `hive/${slugFor(c.item)}`, base: null, local: false });
  await server.dispatch({ type: 'openSession', activityId: workId(server.getState()!, 'local:1') });
  workers[0].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 0);
  const [one, two] = ['local:1', 'local:2'].map((id) => activityOf(server.getState()!, id)!); // #629: the worktrees are the activities'
  const source = sessionsOf(server.getState()!, 'local:1')[0].id;
  const dir = transcriptDir(one.worktree!);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${source}.jsonl`), `${TRANSCRIPT}\n`);
  return { base, server, workers, repo, home, git, source, one: one.worktree!, two: two.worktree!, gate };
}

test('GET …/copy answers the dialog\'s summary: both ends\' paths and branches, the transcript\'s messages, the source\'s tokens and its uncommitted changes, git read with argv arrays (#587)', async (t) => {
  const { base, server, repo, git, source, one } = await twoActivities(t);
  const res = await getJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy?toActivity=${encodeURIComponent(localActivityId(WORKSPACE))}`);
  assert.deepEqual(await res.json(), { from: { path: one, branch: 'feature/x' }, to: { path: repo, branch: 'feature/x' }, messages: 2, tokens: 0, uncommitted: 2 });
  assert.ok(git.some((call) => call.join(' ') === `git -C ${one} status --porcelain`), 'argv, no shell');
  await refused(getJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`), 400, 'destino inválido');
  await refused(getJson(`${base}${workPath(server, 'nope')}/sessions/${source}/copy?toActivity=${encodeURIComponent(localActivityId(WORKSPACE))}`), 404, 'atividade desconhecida'); // #629: no record has that id
  await refused(getJson(`${base}${workPath(server, 'local:1')}/sessions/b1b2c3d4-0000-4000-8000-000000000009/copy?toActivity=${encodeURIComponent(localActivityId(WORKSPACE))}`), 409, 'sessão desconhecida');
});

test('POST …/copy into another activity copies the transcript there, spawns the fork with the notice as its first prompt and the Hive\'s MCP, lists the named copy, and the copy\'s SessionStart removes the temporary transcript (#587)', async (t) => {
  const { base, home, server, workers, source, two } = await twoActivities(t);
  const answer = (await (await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: workId(server.getState()!, 'local:2') }, name: '  no dois  ', notice: true })).json()) as OpenResult;
  const copy = sessionsOf(server.getState()!, 'local:2').at(-1)!;
  const { launch } = workers[1];
  assert.deepEqual(answer, { ok: true, ptyId: launch.ptyId });
  assert.deepEqual([launch.cwd, launch.args], [two, ['--resume', source, '--fork-session', '--session-id', copy.id, '--name=no dois']]);
  assert.equal(copy.name, 'no dois');
  assert.match(await readFile(launch.promptPath!, 'utf8'), /^Hive: this conversation was copied from task HIVE-1 \(one\), branch feature\/x/);
  assert.ok('hive' in (JSON.parse(await readFile(launch.mcpPath!, 'utf8')) as { mcpServers: object }).mcpServers, 'a task\'s copy has the Hive\'s tools');
  assert.equal(launch.protocolPath, join(home, PROTOCOL_DIR, 'workspaces', WORKSPACE, 'session.md'), 'and the session protocol that goes with them (#167)');
  const dir = transcriptDir(two);
  assert.deepEqual(await readdir(dir), [`${source}.jsonl`]);
  await server.dispatch({ type: 'hook', ptyId: launch.ptyId, payload: { hook_event_name: 'SessionStart', session_id: copy.id, cwd: two } });
  assert.deepEqual(await readdir(dir), [], 'the fork has its own transcript by now');
  assert.equal(sessionsOf(server.getState()!, 'local:1').length, 1, 'the original stays as it was');
});

test('POST …/copy into the workspace\'s local runs in the checkout with an MCP config that lists no server and no prompt without the notice, keeps a local session, and /ptys lists it by workspace (#587)', async (t) => {
  const { base, server, workers, repo, source } = await twoActivities(t);
  assert.equal((await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: localActivityId(WORKSPACE) }, notice: false })).status, 200);
  const { launch } = workers[1];
  const [local] = localSessionsOf(server.getState()!, WORKSPACE);
  assert.deepEqual([launch.cwd, launch.promptPath, launch.args.slice(-2)], [repo, undefined, ['--session-id', local.id]]);
  assert.deepEqual(JSON.parse(await readFile(launch.mcpPath!, 'utf8')), { mcpServers: {} });
  assert.equal(launch.protocolPath, undefined, 'a local session has no Hive tools, so no protocol (#167)');
  const listed = (await (await hiveFetch(`${base}/ptys`)).json()) as { ptys: { label: string }[] };
  assert.deepEqual(listed.ptys.map((w) => w.label), [WORKSPACE]);
});

test('POST …/copy refuses a bad body, its own activity, an unknown workspace and a transcript that is gone, and a refusal leaves no temporary transcript (#587)', async (t) => {
  const { base, server, source, one, two } = await twoActivities(t);
  const path = `${base}${workPath(server, 'local:1')}/sessions/${source}/copy`;
  await refused(postJson(path, { notice: true }), 400, 'destino inválido');
  await refused(postJson(path, { to: { activityId: localActivityId(WORKSPACE) }, notice: 'yes' }), 400, 'destino inválido');
  await refused(postJson(path, { to: { activityId: workId(server.getState()!, 'local:1') }, notice: true }), 409, 'a sessão já está aqui');
  await refused(postJson(path, { to: { activityId: localActivityId('site') }, notice: true }), 404, 'atividade desconhecida'); // #629: no local activity of a workspace the Comb lacks
  await rm(join(transcriptDir(one), `${source}.jsonl`));
  await refused(postJson(path, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: true }), 409, 'O histórico desta sessão não existe mais');
  assert.deepEqual(await readdir(transcriptDir(two)).catch(() => []), []);
  assert.equal(server.getState()!.workers.length, 0);
});

test('a local session continues in the checkout, resumed by id, and clears once no run holds it; refusals for an unknown workspace, a held session and a gone transcript (#587)', async (t) => {
  const { base, server, workers, repo, source } = await twoActivities(t);
  await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: localActivityId(WORKSPACE) }, notice: false });
  const [local] = localSessionsOf(server.getState()!, WORKSPACE);
  const open = (id: string, name = WORKSPACE) => postJson(`${base}/activities/${encodeURIComponent(localActivityId(name))}/sessions/${id}/open`);
  await refused(open(local.id), 409, 'sessão já aberta ou desconhecida'); // its copy's run holds it
  await refused(postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/sessions/${local.id}/clear`), 409, 'Esta sessão está em uso ou não existe mais');
  await server.dispatch({ type: 'hook', ptyId: workers[1].launch.ptyId, payload: { hook_event_name: 'SessionStart', session_id: local.id, cwd: repo } }); // it opened
  workers[1].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 0);
  await refused(open(local.id, 'site'), 404, 'atividade desconhecida'); // #629: a workspace the Comb lacks has no local record
  await refused(open(local.id), 409, 'O histórico desta sessão não existe mais'); // the fake claude wrote none
  await mkdir(transcriptDir(repo), { recursive: true });
  await writeFile(join(transcriptDir(repo), `${local.id}.jsonl`), `${TRANSCRIPT}\n`);
  const answer = (await (await open(local.id)).json()) as OpenResult;
  assert.deepEqual([answer.ptyId, workers[2].launch.cwd, workers[2].launch.args], [workers[2].launch.ptyId, repo, ['--resume', local.id]]);
  workers[2].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 0);
  assert.equal((await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/sessions/${local.id}/clear`)).status, 200);
  assert.deepEqual(localSessionsOf(server.getState()!, WORKSPACE), []);
});

test('a turn end of a local session\'s run reads its own transcript in the checkout\'s dir: tokens and /rename title reach its local entry (#587)', async (t) => {
  const { base, server, workers, repo, source } = await twoActivities(t);
  await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: localActivityId(WORKSPACE) }, notice: false });
  const [local] = localSessionsOf(server.getState()!, WORKSPACE);
  const transcript = join(transcriptDir(repo), `${local.id}.jsonl`);
  const lines = [{ type: 'assistant', message: { id: 'm9', usage: { input_tokens: 10, output_tokens: 5 } } }, { type: 'custom-title', customTitle: 'meu' }];
  await writeFile(transcript, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const hook = await hiveFetch(`${base}/hooks/event`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': workers[1].launch.ptyId },
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: local.id, transcript_path: transcript }),
  });
  assert.equal(hook.status, 204);
  const [after] = localSessionsOf(server.getState()!, WORKSPACE);
  assert.deepEqual([after.tokens, after.name], [15, 'meu']);
});

test('POST …/copy whose target starts its delete activity while the copy runs answers 409, spawns nothing and leaves no temporary transcript (#587)', async (t) => {
  const { base, server, source, two, gate } = await twoActivities(t);
  gate.onGit = async () => { await server.dispatch({ type: 'deletingTask', taskId: 'local:2' }); };
  await refused(postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: true }), 409, 'o destino não aceita mais a cópia');
  assert.deepEqual(await readdir(transcriptDir(two)), []);
  assert.equal(server.getState()!.workers.length, 0);
});

test('while a copy\'s temporary transcript waits for its SessionStart, a second copy into the same dir is refused; another dir is not (#587)', async (t) => {
  const { base, server, workers, source } = await twoActivities(t);
  const path = `${base}${workPath(server, 'local:1')}/sessions/${source}/copy`;
  assert.equal((await postJson(path, { to: { activityId: localActivityId(WORKSPACE) }, notice: false })).status, 200);
  await refused(postJson(path, { to: { activityId: localActivityId(WORKSPACE) }, notice: false }), 409, 'uma cópia desta sessão ainda está abrindo');
  assert.equal((await postJson(path, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: false })).status, 200);
  const copy = workers[1].launch;
  await server.dispatch({ type: 'hook', ptyId: copy.ptyId, payload: { hook_event_name: 'SessionStart', session_id: copy.args.at(-1), cwd: copy.cwd } });
  assert.equal((await postJson(path, { to: { activityId: localActivityId(WORKSPACE) }, notice: false })).status, 200, 'settled: the file is gone');
});

test('a repo session whose copy\'s temporary transcript sits in the main repo\'s dir is not opened until the copy settles (#587)', async (t) => {
  const { base, server, workers, repo, source } = await twoActivities(t);
  await server.dispatch({ type: 'deletingTask', taskId: 'local:1' });
  await server.dispatch({ type: 'activityRemoved', activityId: workId(server.getState()!, 'local:1') });
  assert.equal(sessionsOf(server.getState()!, 'local:1')[0].repo, true);
  assert.equal((await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: localActivityId(WORKSPACE) }, notice: false })).status, 200);
  await refused(postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/open`), 409, 'uma cópia desta sessão ainda está abrindo');
  workers[1].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 0 && !existsSync(join(transcriptDir(repo), `${source}.jsonl`)));
  assert.equal((await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/open`)).status, 200, 'its own transcript, adopted from the worktree\'s dir');
});

test('a copy whose spawn fails before its run starts frees its worker, forgets its entry and removes the temporary transcript (#587)', async (t) => {
  const { base, server, home, source, two } = await twoActivities(t);
  const prompts = join(home, PROMPTS_DIR);
  await chmod(prompts, 0o500); // the MCP config cannot be written
  t.after(() => chmod(prompts, 0o700));
  await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: false });
  await waitFor(() => server.getState()!.workers.length === 0);
  assert.deepEqual(sessionsOf(server.getState()!, 'local:2'), []);
  assert.match(server.getState()!.error ?? '', /EACCES/);
  await waitFor(() => !existsSync(join(transcriptDir(two), `${source}.jsonl`)));
});

// Its second boot kills the saved workers' strays by pattern (pkill), which needs the real process list
test('a boot removes the temporary transcript a saved copy mark names in its own task\'s dir, and never a file a forged mark names (#587)', { skip: NO_PROCESS_LIST }, async (t) => {
  const { base, server, home, repo, source, one, two } = await twoActivities(t);
  await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: false });
  const saved = structuredClone(server.getState()!);
  const forged = { ...saved.workers.at(-1)!, id: 'forged', runId: 'c1b2c3d4-0000-4000-8000-000000000007', copyOf: { from: source, dir: transcriptDir(one) } };
  await server.close();
  await writeFile(join(home, 'state.json'), JSON.stringify({ ...saved, workers: [...saved.workers, forged] }));
  await writeFile(join(transcriptDir(two), `${source}.jsonl`), `${TRANSCRIPT}\n`); // as the crashed Hive left it
  const again = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: async () => ({ stdout: '' }) });
  const next = `http://127.0.0.1:${await again.listen(0)}`;
  t.after(() => again.close());
  assert.equal((await postJson(`${next}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  await waitFor(() => !existsSync(join(transcriptDir(two), `${source}.jsonl`)));
  assert.ok(existsSync(join(transcriptDir(one), `${source}.jsonl`)), 'the source\'s own transcript stays');
});

test('a save refuses to re-path a workspace a local session runs in (409) (#587)', async (t) => {
  const { base, server, source } = await twoActivities(t);
  await postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: localActivityId(WORKSPACE) }, notice: false });
  const res = await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt((await tempHive(t)).repo) });
  assert.deepEqual([res.status, await res.json()], [409, { error: `workspace ${WORKSPACE} has a running worker` }]);
});

test('a transcript the Hive cannot read answers 500 with the reason the dialog shows, to the summary and to the copy, and leaves no partial copy (#587)', async (t) => {
  const { base, server, source, one, two } = await twoActivities(t);
  const transcript = join(transcriptDir(one), `${source}.jsonl`);
  await chmod(transcript, 0o000);
  t.after(() => chmod(transcript, 0o600));
  await refused(getJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy?toActivity=${workId(server.getState()!, 'local:2')}`), 500, 'o histórico desta sessão não pôde ser lido');
  await refused(postJson(`${base}${workPath(server, 'local:1')}/sessions/${source}/copy`, { to: { activityId: workId(server.getState()!, 'local:2') }, notice: false }), 500, 'o histórico desta sessão não pôde ser copiado');
  assert.deepEqual(await readdir(transcriptDir(two)).catch(() => []), []);
  assert.equal(server.getState()!.workers.length, 0);
});

test('a deleted activity\'s kept session still copies, opens and clears under /activities/<its id>, while its diff answers 404 (#629)', async (t) => {
  const { base, server, workers, source } = await twoActivities(t);
  const old = activityOf(server.getState()!, 'local:1')!.id;
  assert.deepEqual(await (await postJson(`${base}/activities/${old}/delete`)).json(), { removed: true });
  assert.equal(activityOf(server.getState()!, 'local:1'), undefined);
  await refused(getJson(`${base}/activities/${old}/diff?scope=worktree`), 404, 'atividade desconhecida');
  const live = activityOf(server.getState()!, 'local:2')!.id;
  assert.equal((await getJson(`${base}/activities/${old}/sessions/${source}/copy?toActivity=${live}`)).status, 200);
  assert.equal((await postJson(`${base}/activities/${old}/sessions/${source}/open`)).status, 200, 'a repo session opens in the main repo');
  workers.at(-1)!.handlers.onExit();
  await waitFor(() => server.getState()!.workers.every((w) => w.status === 'empty'));
  assert.equal((await postJson(`${base}/activities/${old}/sessions/${source}/clear`)).status, 200);
  assert.deepEqual(recordOf(server.getState()!, old)?.sessions, []);
});
