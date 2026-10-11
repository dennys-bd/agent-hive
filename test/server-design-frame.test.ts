import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeScript } from '../src/design-bridge.js';
import { initialState } from '../src/orchestrator.js';
import { SECRET_HEADER, secretCookie } from '../src/secret.js';
import { createServer } from '../src/server.js';
import { createDesignFrameTokens, framePolicy, withBridge } from '../src/server-design-frame.js';
import { saveState } from '../src/state-store.js';
import type { Task } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { fakeLog, tempHive } from './fakes.js';
import { savedActivityId, withWork, workPath } from './fixtures/work.js';
import { send, settingsBody } from './review-server.js';
import { directive, hiveFetch, SECRET } from './secret-client.js';

test('the token store answers one 64-hex token per folder for the whole boot, and nothing for a token it never minted (#108)', () => {
  const tokens = createDesignFrameTokens();
  const one = tokens.mint('/work/design');
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(tokens.mint('/work/design'), one, 'minting the folder again');
  const other = tokens.mint('/work/other');
  assert.notEqual(other, one);
  assert.deepEqual([tokens.folderOf(one), tokens.folderOf(other), tokens.folderOf('0'.repeat(64))], ['/work/design', '/work/other', undefined]);
  assert.notEqual(createDesignFrameTokens().mint('/work/design'), one, 'another boot, another token');
});

test('framePolicy sandboxes the frame to scripts, names the route in every source it allows, and closes connections, frames, forms and base (#108)', () => {
  const route = 'http://127.0.0.1:4242/design-frame/abc/';
  assert.equal(framePolicy('127.0.0.1:4242', 'abc'), [
    'sandbox allow-scripts', "default-src 'none'", `script-src ${route} 'unsafe-inline' data: blob:`, `style-src ${route} 'unsafe-inline' data: blob:`,
    `img-src ${route} data: blob:`, `font-src ${route} data: blob:`, `media-src ${route} data: blob:`, "connect-src 'none'", "frame-src 'none'",
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
  ].join('; '));
});

test('withBridge puts the bridge right after <head>, any case or attributes, else before the first element, never before the doctype nor after <header> (#108)', () => {
  const b = bridgeScript();
  assert.equal(withBridge('<!doctype html><html><HEAD lang="en"><title>x</title></HEAD></html>'), `<!doctype html><html><HEAD lang="en">${b}<title>x</title></HEAD></html>`);
  assert.equal(withBridge('<!doctype html><header>top</header><p>x</p>'), `<!doctype html>${b}<header>top</header><p>x</p>`);
  assert.equal(withBridge('just text'), `${b}just text`);
});

const SLUG = 'hive-1-design';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Design', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const DESIGN = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>';
const CSS = 'h1 { color: red; }\n';

interface Frames { base: string; port: number; repo: string; activity: string; lines: string[] }

// One local task whose worktree holds design/ (a design, its stylesheet, a note, a folder, a symlink out to secret.txt beside design/);
// the checkout holds a design outside the worktree
async function startFrames(t: TestContext): Promise<Frames> {
  const made = await tempHive(t);
  const repo = await realpath(made.repo); // locate answers real paths: macOS's tmpdir is a symlink
  const worktree = worktreePath(repo, SLUG);
  const design = join(worktree, 'design');
  await mkdir(join(design, 'assets'), { recursive: true });
  await writeFile(join(design, 'home.hv.html'), DESIGN);
  await writeFile(join(design, 'style.css'), CSS);
  await writeFile(join(design, 'notes.md'), '# notes\n');
  await writeFile(join(worktree, 'secret.txt'), 'outside the design folder\n');
  await symlink(join(worktree, 'secret.txt'), join(design, 'link.css'));
  await writeFile(join(repo, 'outside.hv.html'), DESIGN);
  await saveState(made.home, withWork({ ...initialState(0), localCount: 1, tasks: [TASK] }, 'local:1', { id: savedActivityId(1), slug: SLUG }));
  const { log, lines } = fakeLog();
  const server = createServer({ secret: SECRET, home: made.home, exec: async () => ({ stdout: '' }), log });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo))).status, 200);
  return { base, port, repo, activity: workPath(server, 'local:1'), lines };
}

const mint = (f: Frames, path: string, fetcher: (url: string) => Promise<Response> = hiveFetch): Promise<Response> =>
  fetcher(`${f.base}${f.activity}/design-frame?${new URLSearchParams({ path })}`);

async function minted(f: Frames, path: string): Promise<string> {
  const res = await mint(f, path);
  assert.equal(res.status, 200, path);
  return ((await res.json()) as { url: string }).url;
}

test('a minted URL serves the design without the secret, with the frame policy, nosniff, no-store and the bridge after <head>; a sibling .css under the same token gets the same policy and no bridge; minting again answers the same URL (#108)', async (t) => {
  const f = await startFrames(t);
  const url = await minted(f, 'design/home.hv.html');
  const [, token] = /^\/design-frame\/([0-9a-f]{64})\/home\.hv\.html$/.exec(url) ?? [];
  assert.ok(token, url);
  assert.equal(await minted(f, 'design/home.hv.html'), url, 'one token per folder per boot');
  const page = await fetch(`${f.base}${url}`);
  assert.equal(page.status, 200);
  const policy = page.headers.get('content-security-policy') ?? '';
  assert.equal(policy, framePolicy(`127.0.0.1:${f.port}`, token));
  assert.deepEqual(directive(policy, 'sandbox'), ['allow-scripts']);
  assert.deepEqual(directive(policy, 'connect-src'), ["'none'"]);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(await page.text(), DESIGN.replace('<head>', `<head>${bridgeScript()}`));
  const css = await fetch(`${f.base}/design-frame/${token}/style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-security-policy'), policy);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  assert.equal(await css.text(), CSS);
});

test('an unknown token, a ../ path, a symlink out of the folder, a folder and a missing file answer 404 with no body, the port\'s cookie and secret changing nothing; the debug line names neither the token nor the path (#108)', async (t) => {
  const f = await startFrames(t);
  const url = await minted(f, 'design/home.hv.html');
  const folder = url.slice(0, url.lastIndexOf('/') + 1);
  const unknown = `/design-frame/${'0'.repeat(64)}/home.hv.html`;
  const credentials = { cookie: `${secretCookie(f.port)}=${SECRET}`, [SECRET_HEADER]: SECRET };
  // %2F keeps ../ inside one segment: fetch's URL parser resolves a bare ../ (and %2e%2e) before the request leaves
  const asked: [string, Record<string, string>][] = [
    [unknown, {}], [unknown, credentials], [`${folder}..%2Fsecret.txt`, {}], [`${folder}link.css`, {}], [`${folder}assets`, {}], [`${folder}nope.css`, {}],
  ];
  for (const [path, headers] of asked) {
    const res = await fetch(`${f.base}${path}`, { headers });
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), '', path);
  }
  assert.ok(f.lines.includes('DEBUG refused design frame: GET'), f.lines.join('\n'));
  const token = url.split('/')[2];
  assert.ok(!f.lines.some((line) => line.includes(token) || line.includes('secret.txt') || line.includes('0'.repeat(64))), 'no token, no path in hive.log');
});

test('the mint stays behind the gate: 403 without the secret; 400 for a file that is not a .hv.html; 404 for a design outside the worktree or an unknown activity (#108)', async (t) => {
  const f = await startFrames(t);
  const bare = await mint(f, 'design/home.hv.html', fetch);
  assert.equal(bare.status, 403);
  assert.deepEqual(await bare.json(), { error: 'segredo inválido' });
  const notDesign = await mint(f, 'design/notes.md');
  assert.equal(notDesign.status, 400);
  assert.deepEqual(await notDesign.json(), { error: 'not a Hive design' });
  const outside = await mint(f, join(f.repo, 'outside.hv.html'));
  assert.equal(outside.status, 404);
  assert.deepEqual(await outside.json(), { error: 'file not found' });
  const unknown = await hiveFetch(`${f.base}/activities/${savedActivityId(99)}/design-frame?path=design%2Fhome.hv.html`);
  assert.equal(unknown.status, 404);
});
