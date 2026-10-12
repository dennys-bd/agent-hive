import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, CLOSE_TAB_DEFAULTS, SLEEP_NOTICE_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, type Stage, type Task, type Exec, type SettingsBody } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';
import { withWork, savedActivityId } from './fixtures/work.js';

export const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
export const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
export const SESSION_OTHER = 'cccccccc-3333-4333-8333-333333333333'; // task 2's
export const DIFF_TEXT = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', ''].join('\n');
const AT = '2026-09-29T10:00:00.000Z';
const session = (id: string, lastUsedAt = AT) => ({ id, startedAt: AT, stages: ['fila'], agent: 'claude' as const, lastUsedAt });

export interface Reviews { base: string; home: string; server: HiveServer }

/** A first setup's body (#591, #592): one workspace at `repo`, no source, these stages. */
export const settingsBody = (repo: string, stages: Stage[] = LOCAL_STAGES): SettingsBody => ({
  prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, ...CLOSE_TAB_DEFAULTS, ...SLEEP_NOTICE_DEFAULTS, defaultAgent: 'claude', theme: 'system',
  terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
});

/** A Comb with no source and two local tasks: 1 has a worktree on disk and sessions A and B, 2 has none and its own session. git answers the
 * diff route; `extra` reaches createServer (a fake deliverReview, #591). */
export async function startReviews(t: TestContext, extra: Partial<ServerDeps> = {}): Promise<Reviews> {
  const { home, repo } = await tempHive(t);
  const worktree = worktreePath(repo, 'hive-1-task');
  await mkdir(worktree, { recursive: true });
  const task = (n: number, more: Partial<Task>): Task => ({
    item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...more,
  });
  const tasks = [task(1, {}), task(2, {})];
  // #629: a saved id survives the load
  const one = withWork({ ...initialState(0), localCount: 2, tasks }, 'local:1', { id: savedActivityId(1), slug: 'hive-1-task', worktree }, { sessions: [session(SESSION_A), session(SESSION_B, '2026-09-29T11:00:00.000Z')] });
  await saveState(home, withWork(one, 'local:2', { id: savedActivityId(2), slug: 'hive-2-task' }, { sessions: [session(SESSION_OTHER)] })); // #629: the sessions are the records'
  const index = join(await tempDir(t, 'index-'), 'index');
  await writeFile(index, 'the real index');
  const exec: Exec = async (_file, args) => {
    if (args.includes('--git-path')) return { stdout: `${index}\n` };
    if (args.includes('merge-base')) return { stdout: `${'a'.repeat(40)}\n` };
    return { stdout: args.includes('diff') ? DIFF_TEXT : '' };
  };
  const server = createServer({ secret: SECRET, home, exec, ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo))).status, 200);
  return { base, home, server };
}

/** A dashboard request with its body and the UI header (the CSRF gate). */
export const send = (base: string, method: string, path: string, body?: unknown, ui = true): Promise<Response> =>
  hiveFetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(ui ? { 'x-hive-ui': '1' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The data of the first `review` event /events streams while `act` runs (#591). */
export async function reviewEventDuring(base: string, act: () => Promise<unknown>): Promise<unknown> {
  const reader = (await hiveFetch(`${base}/events`, { signal: AbortSignal.timeout(5000) })).body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true }); // the State every connection gets first
  await act();
  while (!text.includes('event: review')) text += decoder.decode((await reader.read()).value, { stream: true });
  await reader.cancel();
  const frame = text.slice(text.indexOf('event: review')).split('\n\n')[0];
  return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length));
}
