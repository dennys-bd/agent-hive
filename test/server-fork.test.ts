import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import type { Exec, WorkspaceFork } from '../src/types.js';
import { tempHive, workspacesAt } from './fakes.js';
import { send, settingsBody } from './review-server.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The fork's routes (#854): the manual sync, answered and never kept, and the remotes Settings reads.

const COMPARE = 'repos/me/app/compare/main...acme:main';
const LIST = 'origin\tgit@github.com:me/app.git (fetch)\norigin\tgit@github.com:me/app.git (push)\nupstream\thttps://github.com/acme/app.git (fetch)\n';
// git answering the fork's two remotes, origin's HEAD and the remote list; gh answering the compare with `compare` and recording every call
function forkExec(compare: () => string): { exec: Exec; gh: string[][] } {
  const gh: string[][] = [];
  const exec: Exec = async (file, args) => {
    if (file === 'gh') {
      gh.push(args);
      return { stdout: args.includes(COMPARE) ? compare() : '{"merge_type":"fast-forward"}' };
    }
    if (args.includes('get-url')) return { stdout: args.at(-1) === 'upstream' ? 'https://github.com/acme/app.git\n' : 'git@github.com:me/app.git\n' };
    if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
    return { stdout: args.includes('-v') ? LIST : '' };
  };
  return { exec, gh };
}

async function startFork(t: TestContext, fork: WorkspaceFork | false | null, exec: Exec): Promise<{ base: string; repo: string }> {
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', { ...settingsBody(repo), workspaces: [{ ...workspacesAt(repo)[0], fork }] })).status, 200);
  return { base, repo };
}

const MANUAL: WorkspaceFork = { remote: 'upstream', pr: 'fork', sync: 'manual' };

test('POST /workspaces/:name/sync runs the GitHub sync of the workspace\'s base and answers it: current, synced through merge-upstream, diverged with no write; gh\'s refusal is an error, never a 500 (#854)', async (t) => {
  let compare = (): string => '{"ahead_by":0,"behind_by":0}';
  const { exec, gh } = forkExec(() => compare());
  const { base } = await startFork(t, MANUAL, exec);
  const sync = async (): Promise<unknown> => (await send(base, 'POST', '/workspaces/hive/sync')).json();
  assert.deepEqual(await sync(), { mode: 'github', base: 'me:main', result: 'current', commits: 0 });
  compare = () => '{"ahead_by":3,"behind_by":0}';
  assert.deepEqual(await sync(), { mode: 'github', base: 'me:main', result: 'synced', commits: 3 });
  assert.deepEqual(gh.at(-1), ['api', '-X', 'POST', 'repos/me/app/merge-upstream', '-f', 'branch=main']);
  compare = () => '{"ahead_by":1,"behind_by":2}';
  assert.deepEqual(await sync(), { mode: 'github', base: 'me:main', result: 'diverged', commits: 2 });
  assert.equal(gh.filter((args) => args.includes('-X')).length, 1, 'no write on a diverged fork');
  compare = () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)\n' }); };
  const refused = await send(base, 'POST', '/workspaces/hive/sync');
  assert.deepEqual([refused.status, await refused.json()], [200, { mode: 'github', base: 'me:main', result: 'error', reason: 'gh: Not Found (HTTP 404)' }]);
});

test('the manual sync is 404 for an unknown workspace and 409 unless the workspace\'s fork syncs by hand (#854)', async (t) => {
  const github = await startFork(t, { remote: 'upstream', pr: 'fork', sync: 'github' }, forkExec(() => '{}').exec);
  const unknown = await send(github.base, 'POST', '/workspaces/nope/sync');
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'workspace desconhecido' }]);
  const automatic = await send(github.base, 'POST', '/workspaces/hive/sync');
  assert.deepEqual([automatic.status, await automatic.json()], [409, { error: 'a fork deste workspace não sincroniza à mão' }]);
  const plain = await startFork(t, false, forkExec(() => '{}').exec);
  assert.equal((await send(plain.base, 'POST', '/workspaces/hive/sync')).status, 409);
});

test('GET /settings/remotes answers the folder\'s remotes with their GitHub repositories; a folder that is not a repository\'s top level is 400 (#854)', async (t) => {
  const { base, repo } = await startFork(t, null, forkExec(() => '{}').exec);
  const read = await hiveFetch(`${base}/settings/remotes?${new URLSearchParams({ path: repo })}`);
  assert.deepEqual(await read.json(), [{ name: 'origin', repository: 'me/app' }, { name: 'upstream', repository: 'acme/app' }]);
  const bad = await hiveFetch(`${base}/settings/remotes?${new URLSearchParams({ path: 'relative/path' })}`);
  assert.equal(bad.status, 400);
  assert.equal((await hiveFetch(`${base}/settings/remotes`)).status, 400);
});
