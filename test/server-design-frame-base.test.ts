import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bridgeScript } from '../src/design-bridge.js';
import { OUTPUT_MAX } from '../src/design-parts.js';
import { initialState } from '../src/orchestrator.js';
import { createServer } from '../src/server.js';
import { framePolicy } from '../src/server-design-frame.js';
import { saveState } from '../src/state-store.js';
import type { Exec, Task } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { fakeLog, tempHive } from './fakes.js';
import { savedActivityId, withWork, workPath } from './fixtures/work.js';
import { send, settingsBody } from './review-server.js';
import { hiveFetch, SECRET } from './secret-client.js';

// GET /activities/:id/design-frame-base (#675) and the frame route under its tokens, over a real repository: the first commit is the task's
// base (BASE_REF), the second changes the screen and its part, and the disk changes both again. Only the routes' git runs for real
const run: Exec = promisify(execFile);
const ROUTE_GIT = ['rev-parse', 'cat-file', 'merge-base'];
const exec: Exec = (file, args, opts) => (file === 'git' && ROUTE_GIT.some((command) => args.includes(command)) ? run(file, args, opts) : Promise.resolve({ stdout: '' }));
const SLUG = 'hive-1-design';
const BASE_REF = 'hive-675-base';
const PATH = 'design/home.hv.html';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Design', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const CSS = 'h1 { color: red; }\n';
const screenOf = (word: string): string => `<!doctype html><html><head></head><body><h1>${word}</h1><hv-include src="parts/nav.html"></hv-include></body></html>`;
// The screen as the frame serves it: its part in place and marked, the bridge handed the part
const servedOf = (word: string): string =>
  `<!doctype html><html><head>${bridgeScript(['parts/nav.html'])}</head><body><h1>${word}</h1><nav data-hv-source="parts/nav.html">${word}</nav></body></html>`;

interface BaseFrames { base: string; port: number; activity: string; lines: string[]; git(...args: string[]): Promise<string> }
type Git = BaseFrames['git'];

async function writeScreen(design: string, word: string): Promise<void> {
  await writeFile(join(design, 'home.hv.html'), screenOf(word));
  await writeFile(join(design, 'parts', 'nav.html'), `<nav>${word}</nav>`);
}

// The base commit holds the screen, a stylesheet, a note, a dotfile, a blob past OUTPUT_MAX, a link out and a screen at the worktree's root;
// the second commit changes the screen; the disk changes it again and adds a screen the base lacks
async function commitDesign(worktree: string, git: Git): Promise<void> {
  const design = join(worktree, 'design');
  await mkdir(join(design, 'parts'), { recursive: true });
  await writeScreen(design, 'One');
  await writeFile(join(design, 'style.css'), CSS);
  await writeFile(join(design, 'notes.md'), '# notes\n');
  await writeFile(join(design, '.env'), 'TOKEN=x\n');
  await writeFile(join(design, 'big.css'), 'a'.repeat(OUTPUT_MAX + 1));
  await writeFile(join(worktree, 'secret.txt'), 'outside the design folder\n');
  await writeFile(join(worktree, 'root.hv.html'), screenOf('Root'));
  await symlink(join(worktree, 'secret.txt'), join(design, 'link.css'));
  await git('add', '--force', '--all'); // --force: a global excludes file may ignore .hive
  await git('commit', '--quiet', '-m', 'base');
  await git('branch', BASE_REF);
  await writeScreen(design, 'Two');
  await git('commit', '--quiet', '-am', 'second');
  await writeScreen(design, 'Disk');
  await writeFile(join(design, 'added.hv.html'), screenOf('Added'));
}

async function startBaseFrames(t: TestContext): Promise<BaseFrames> {
  const made = await tempHive(t);
  const repo = await realpath(made.repo);
  const git: Git = async (...args) =>
    (await run('git', ['-C', repo, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();
  await commitDesign(worktreePath(repo, SLUG), git);
  await saveState(made.home, withWork({ ...initialState(0), localCount: 1, tasks: [TASK] }, 'local:1', { id: savedActivityId(1), slug: SLUG, base: { ref: BASE_REF, tellWorker: false } }));
  const { log, lines } = fakeLog();
  const server = createServer({ secret: SECRET, home: made.home, exec, log });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo))).status, 200);
  return { base, port, activity: workPath(server, 'local:1'), lines, git };
}

const mintBase = (f: BaseFrames, path: string, against: string, fetcher: (url: string) => Promise<Response> = hiveFetch): Promise<Response> =>
  fetcher(`${f.base}${f.activity}/design-frame-base?${new URLSearchParams({ path, against })}`);
async function mintedBase(f: BaseFrames, path: string, against: string): Promise<string> {
  const res = await mintBase(f, path, against);
  const body = (await res.json()) as { url?: string };
  assert.ok(res.status === 200 && body.url !== undefined, JSON.stringify(body));
  return body.url;
}
const textAt = async (f: BaseFrames, url: string): Promise<string> => (await fetch(`${f.base}${url}`)).text();
const tokenOf = (url: string): string => /^\/design-frame\/([0-9a-f]{64})\/home\.hv\.html$/.exec(url)?.[1] ?? '';

test('the base mint answers a frame URL of HEAD\'s and of the task base\'s screen, a token each, minted once; the frame serves that commit\'s screen with its part from the same commit, under the frame policy (#675)', async (t) => {
  const f = await startBaseFrames(t);
  const head = await mintedBase(f, PATH, 'head');
  const task = await mintedBase(f, PATH, 'task');
  assert.ok(tokenOf(head) !== '' && tokenOf(task) !== '' && tokenOf(head) !== tokenOf(task), `${head} ${task}`);
  assert.equal(await mintedBase(f, PATH, 'head'), head, 'the same commit and folder: the same token');
  const page = await fetch(`${f.base}${head}`);
  assert.equal(page.headers.get('content-security-policy'), framePolicy(`127.0.0.1:${f.port}`, tokenOf(head)));
  assert.deepEqual([page.headers.get('cache-control'), page.headers.get('x-content-type-options'), page.headers.get('referrer-policy')], ['no-store', 'nosniff', 'no-referrer']);
  assert.equal(await page.text(), servedOf('Two'));
  assert.equal(await textAt(f, task), servedOf('One'));
  assert.equal(await textAt(f, head.replace('home.hv.html', 'style.css')), CSS);
});

test('a screen the base does not have answers missing; the base mint refuses as design-frame does, an against other than head or task, and a call without the secret (#675)', async (t) => {
  const f = await startBaseFrames(t);
  const added = await mintBase(f, 'design/added.hv.html', 'head');
  assert.deepEqual([added.status, await added.json()], [200, { missing: true }]);
  const refused: [string, string, number, unknown][] = [
    ['design/notes.md', 'head', 400, { error: 'not a Hive design' }],
    ['root.hv.html', 'head', 404, { error: 'file not found' }], // its token would serve the whole worktree
    [PATH, 'stage', 400, { error: 'against must be head or task' }],
  ];
  for (const [path, against, status, body] of refused) {
    const res = await mintBase(f, path, against);
    assert.deepEqual([res.status, await res.json()], [status, body], `${path} ${against}`);
  }
  assert.equal((await mintBase(f, PATH, 'head', fetch)).status, 403);
});

test('under a base token, an escape, a dot segment, a folder, a symbolic link, a blob past OUTPUT_MAX and a path the commit lacks answer 404 with no body; the debug line names neither (#675)', async (t) => {
  const f = await startBaseFrames(t);
  const url = await mintedBase(f, PATH, 'head');
  const folder = url.slice(0, url.lastIndexOf('/') + 1);
  // %2F keeps ../ inside one segment: fetch's URL parser resolves a bare ../ before the request leaves
  for (const asked of ['..%2Fsecret.txt', '.env', 'parts', 'link.css', 'big.css', 'nope.css']) {
    const res = await fetch(`${f.base}${folder}${asked}`);
    assert.deepEqual([res.status, await res.text()], [404, ''], asked);
  }
  assert.ok(f.lines.includes('DEBUG refused design frame: GET'), f.lines.join('\n'));
  assert.ok(!f.lines.some((line) => line.includes(tokenOf(url)) || line.includes('secret.txt')), 'no token, no path in hive.log');
});

test('a commit made after the mint does not change what its token serves; a mint after it answers the new commit\'s token (#675)', async (t) => {
  const f = await startBaseFrames(t);
  const before = await mintedBase(f, PATH, 'head');
  await f.git('commit', '--quiet', '-am', 'third'); // the disk's version becomes HEAD
  assert.equal(await textAt(f, before), servedOf('Two'));
  const after = await mintedBase(f, PATH, 'head');
  assert.notEqual(after, before);
  assert.equal(await textAt(f, after), servedOf('Disk'));
});
