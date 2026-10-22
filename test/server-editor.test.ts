import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { localActivityId } from '../src/activities.js';
import type { ChannelView } from '../src/console.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { CustomFormatter, FileSaved, FileText, EditorConfig, FormatterState, SettingsBody, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, EDITOR_FILE_MAX, FORMATTER_IDS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, tempHive, workspacesAt } from './fakes.js';
import { savedActivityId, withKeptRecord, withWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// A Comb with no source: one local task whose activity's worktree holds docs/spec.md, with a CRLF line (#717)
const SLUG = 'hive-1-spec';
const SPEC = '# spec\r\nline\n';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Spec', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const UI_HEADERS = { 'content-type': 'application/json', 'x-hive-ui': '1' };
const MISSING = 'file not found';
const NO_PATH = 'path must be a non-empty string';
const SAVE_BODY = 'path must be a non-empty string, text and version strings, format a boolean';
const TOO_LARGE = 'arquivo grande demais para o editor';
const READ_ONLY = 'arquivo somente leitura';
const BINARY = 'arquivo binário ou fora de UTF-8';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]); // a PNG's signature and NULs: no UTF-8 text (#498)
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface Editor { base: string; repo: string; worktree: string; server: HiveServer }

// deleted: the activity is gone, its record alone kept (#629)
async function startEditor(t: TestContext, { isDeleted = false, editor = EDITOR_DEFAULTS }: { isDeleted?: boolean; editor?: EditorConfig } = {}): Promise<Editor> {
  const made = await tempHive(t);
  const repo = await realpath(made.repo); // resolveActivityPath answers real paths: macOS's tmpdir is a symlink
  const worktree = worktreePath(repo, SLUG);
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await writeFile(join(worktree, 'docs', 'spec.md'), SPEC);
  const base0 = { ...initialState(0), localCount: 1, tasks: [TASK] };
  const state = isDeleted
    ? withKeptRecord(base0, 'local:1', savedActivityId(1), { slug: SLUG })
    : withWork(base0, 'local:1', { id: savedActivityId(1), slug: SLUG });
  await saveState(made.home, state);
  const server = createServer({ secret: SECRET, home: made.home, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor, commands: [] };
  assert.equal((await hiveFetch(`${base}/settings`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify(body) })).status, 200);
  return { base, repo, worktree, server };
}

const taskActivity = (e: Editor): string => workPath(e.server, 'local:1');
const localActivity = `/activities/${encodeURIComponent(localActivityId('hive'))}`;
const get = (e: Editor, path: string, route: 'file' | 'file-version' | 'image' = 'file', activity = taskActivity(e)): Promise<Response> =>
  hiveFetch(`${e.base}${activity}/${route}?${new URLSearchParams({ path })}`);
const put = (e: Editor, body: unknown, activity = taskActivity(e)): Promise<Response> =>
  hiveFetch(`${e.base}${activity}/file`, { method: 'PUT', headers: UI_HEADERS, body: JSON.stringify(body) });

test('GET file answers the text and the sha256 of its bytes, CRLF kept; file-version answers the same version (#717)', async (t) => {
  const e = await startEditor(t);
  const res = await get(e, 'docs/spec.md');
  assert.equal(res.status, 200);
  const read = (await res.json()) as FileText;
  assert.deepEqual(read, { path: 'docs/spec.md', text: SPEC, version: sha(SPEC) });
  assert.deepEqual(await (await get(e, 'docs/spec.md', 'file-version')).json(), { version: read.version });
});

test('no path is a 400, a missing file or a folder a 404 (a ../ one too), an unknown activity a 404, on both reads (#717, #697)', async (t) => {
  const e = await startEditor(t);
  const cases: [string, number, string][] = [['', 400, NO_PATH], ['docs/nope.md', 404, MISSING], ['docs', 404, MISSING], ['../../../no-such-697.md', 404, MISSING]];
  for (const route of ['file', 'file-version'] as const) {
    for (const [path, status, error] of cases) {
      const res = await get(e, path, route);
      assert.equal(res.status, status, `${route} ${path}`);
      assert.deepEqual(await res.json(), { error }, `${route} ${path}`);
    }
  }
  const unknown = await get(e, 'docs/spec.md', 'file', `/activities/${savedActivityId(99)}`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'atividade desconhecida' });
});

test('a file outside the activity\'s folder reads, versions and saves by its absolute path, a ../ path or a symlink out; the size cap still applies (#697)', async (t) => {
  const e = await startEditor(t);
  const outside = join(await realpath(await tempDir(t, 'docs-repo-')), 'plan.md');
  await writeFile(outside, '# plan\n');
  await symlink(outside, join(e.worktree, 'link.md'));
  await writeFile(join(e.repo, 'notes.md'), 'notes\n');
  await writeFile(join(e.repo, 'big.md'), 'a'.repeat(EDITOR_FILE_MAX + 1));
  assert.deepEqual(await (await get(e, outside)).json(), { path: outside, text: '# plan\n', version: sha('# plan\n') });
  assert.deepEqual(await (await get(e, 'link.md', 'file-version')).json(), { version: sha('# plan\n') });
  assert.deepEqual(await (await get(e, '../../../notes.md')).json(), { path: '../../../notes.md', text: 'notes\n', version: sha('notes\n') }, 'from the worktree up to the checkout');
  const saved = await put(e, { path: outside, text: '# plan, edited\n', version: sha('# plan\n'), format: false });
  assert.deepEqual(await saved.json(), { version: sha('# plan, edited\n') });
  assert.equal(await readFile(outside, 'utf8'), '# plan, edited\n');
  assert.deepEqual(await readdir(dirname(outside)), ['plan.md'], 'no temp file left beside it');
  assert.equal((await get(e, '../../../big.md')).status, 413);
});

test('GET file: a file over 1 MB is a 413; a NUL in its first 8 KB or bytes that are not UTF-8 a 415; exactly 1 MB opens (#717, #498)', async (t) => {
  const e = await startEditor(t);
  await writeFile(join(e.worktree, 'big.txt'), 'a'.repeat(EDITOR_FILE_MAX + 1));
  await writeFile(join(e.worktree, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(e.worktree, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1
  await writeFile(join(e.worktree, 'edge.txt'), 'a'.repeat(EDITOR_FILE_MAX));
  const cases: [string, number, string][] = [['big.txt', 413, TOO_LARGE], ['nul.bin', 415, BINARY], ['latin1.txt', 415, BINARY]];
  for (const [path, status, error] of cases) {
    const res = await get(e, path);
    assert.equal(res.status, status, path);
    assert.deepEqual(await res.json(), { error }, path);
  }
  assert.equal((await get(e, 'edge.txt')).status, 200);
});

test('file-version answers an image\'s sha256 whatever its bytes and size; a text path keeps the read\'s 413 / 415 and its version (#498)', async (t) => {
  const e = await startEditor(t);
  const big = Buffer.concat([PNG, Buffer.alloc(EDITOR_FILE_MAX)]);
  await writeFile(join(e.worktree, 'shot.png'), PNG);
  await writeFile(join(e.worktree, 'big.PNG'), big);
  await writeFile(join(e.worktree, 'big.txt'), 'a'.repeat(EDITOR_FILE_MAX + 1));
  await writeFile(join(e.worktree, 'nul.bin'), PNG);
  assert.deepEqual(await (await get(e, 'shot.png', 'file-version')).json(), { version: sha(PNG) });
  assert.deepEqual(await (await get(e, 'big.PNG', 'file-version')).json(), { version: sha(big) });
  assert.deepEqual([(await get(e, 'big.txt', 'file-version')).status, (await get(e, 'nul.bin', 'file-version')).status], [413, 415]);
  const read = (await (await get(e, 'docs/spec.md')).json()) as FileText;
  assert.deepEqual(await (await get(e, 'docs/spec.md', 'file-version')).json(), { version: read.version });
});

test('PUT with the version read writes the text, the file\'s mode kept and no temp file left, and answers the new version; a symlink inside writes its target (#717)', async (t) => {
  const e = await startEditor(t);
  const spec = join(e.worktree, 'docs', 'spec.md');
  await chmod(spec, 0o755);
  const res = await put(e, { path: 'docs/spec.md', text: '# spec\r\nedited\n', version: sha(SPEC), format: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: sha('# spec\r\nedited\n') });
  assert.equal(await readFile(spec, 'utf8'), '# spec\r\nedited\n');
  assert.equal((await stat(spec)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(join(e.worktree, 'docs')), ['spec.md']);
  await symlink('spec.md', join(e.worktree, 'docs', 'alias.md'));
  assert.equal((await put(e, { path: 'docs/alias.md', text: 'through the link', version: sha('# spec\r\nedited\n'), format: false })).status, 200);
  assert.equal(await readFile(spec, 'utf8'), 'through the link');
  assert.equal((await lstat(join(e.worktree, 'docs', 'alias.md'))).isSymbolicLink(), true);
});

test('PUT over a version the disk no longer holds is a 409 with the disk\'s version, the file untouched (#717)', async (t) => {
  const e = await startEditor(t);
  const spec = join(e.worktree, 'docs', 'spec.md');
  await writeFile(spec, 'an agent wrote this');
  const res = await put(e, { path: 'docs/spec.md', text: 'mine', version: sha(SPEC), format: false });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'o arquivo mudou no disco', version: sha('an agent wrote this') });
  assert.equal(await readFile(spec, 'utf8'), 'an agent wrote this');
});

test('PUT refuses a bad body with a 400, a text over 1 MB as UTF-8 with a 413, and a body over the JSON limit with the same 413, writing nothing (#717)', async (t) => {
  const e = await startEditor(t);
  const version = sha(SPEC);
  for (const bad of [{}, { path: '', text: 'x', version, format: false }, { path: 'docs/spec.md', text: 3, version, format: false }, { path: 'docs/spec.md', text: 'x', format: false }, { path: 'docs/spec.md', text: 'x', version }, { path: 'docs/spec.md', text: 'x', version, format: 'yes' }]) {
    const res = await put(e, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: SAVE_BODY }, JSON.stringify(bad));
  }
  const over = await put(e, { path: 'docs/spec.md', text: 'é'.repeat(EDITOR_FILE_MAX / 2 + 1), version, format: false }); // two bytes each in UTF-8
  assert.equal(over.status, 413);
  assert.deepEqual(await over.json(), { error: TOO_LARGE });
  const huge = await put(e, { path: 'docs/spec.md', text: 'a'.repeat(3 * EDITOR_FILE_MAX), version, format: false }); // past express.json's 2 MB
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: TOO_LARGE });
  assert.equal(await readFile(join(e.worktree, 'docs', 'spec.md'), 'utf8'), SPEC);
});

test('a workspace\'s local activity reads and writes a file of the workspace\'s checkout (#400, #717)', async (t) => {
  const e = await startEditor(t);
  await mkdir(join(e.repo, 'src'));
  await writeFile(join(e.repo, 'src', 'app.ts'), 'export {};\n');
  const read = (await (await get(e, 'src/app.ts', 'file', localActivity)).json()) as FileText;
  assert.equal(read.text, 'export {};\n');
  assert.equal((await put(e, { path: 'src/app.ts', text: 'export const a = 1;\n', version: read.version, format: false }, localActivity)).status, 200);
  assert.equal(await readFile(join(e.repo, 'src', 'app.ts'), 'utf8'), 'export const a = 1;\n');
});

test('a deleted activity\'s file is refused with a 409 on every route, the file left as it was (#629, #717)', async (t) => {
  const e = await startEditor(t, { isDeleted: true });
  await mkdir(join(e.repo, 'docs'), { recursive: true });
  await writeFile(join(e.repo, 'docs', 'spec.md'), '# merged');
  const record = `/activities/${savedActivityId(1)}`;
  const answers = [
    await get(e, 'docs/spec.md', 'file', record),
    await get(e, 'docs/spec.md', 'file-version', record),
    await get(e, 'docs/spec.md', 'image', record),
    await put(e, { path: 'docs/spec.md', text: 'x', version: sha('# merged'), format: false }, record),
  ];
  for (const res of answers) {
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'a atividade foi apagada' });
  }
  assert.equal(await readFile(join(e.repo, 'docs', 'spec.md'), 'utf8'), '# merged');
});

test('PUT over a file that grew past 1 MB is a 413 without reading it, and over a read-only file a 409, both left untouched (#717)', async (t) => {
  const e = await startEditor(t);
  const big = join(e.worktree, 'big.txt');
  await writeFile(big, 'a'.repeat(EDITOR_FILE_MAX + 1));
  const tooBig = await put(e, { path: 'big.txt', text: 'small', version: sha('x'), format: false });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: TOO_LARGE });
  const spec = join(e.worktree, 'docs', 'spec.md');
  await chmod(spec, 0o444);
  const readOnly = await put(e, { path: 'docs/spec.md', text: 'mine', version: sha(SPEC), format: false });
  assert.equal(readOnly.status, 409);
  assert.deepEqual(await readOnly.json(), { error: READ_ONLY });
  assert.equal(await readFile(spec, 'utf8'), SPEC);
});

// Custom formatters: they always win the pick, so these tests never depend on a tool installed on the machine
const UPPER: CustomFormatter = { name: 'upper', command: 'tr a-z A-Z', extensions: ['.md'], workspaces: 'all' };
const BROKEN: CustomFormatter = { name: 'broken', command: 'cat > /dev/null; echo "no config found" >&2; exit 3', extensions: ['.md'], workspaces: 'all' };
const formats = (custom: CustomFormatter[], enabled = true): EditorConfig => ({ formatOnSave: { enabled, workspaces: 'all' }, languages: { markdown: { custom } } });

test('PUT with format and a workspace that formats on save writes the formatter\'s text and answers it; format false, or onSave off, writes the text as sent (#749)', async (t) => {
  const e = await startEditor(t, { editor: formats([UPPER]) });
  const spec = join(e.worktree, 'docs', 'spec.md');
  const res = await put(e, { path: 'docs/spec.md', text: '# spec\nedited\n', version: sha(SPEC), format: true });
  assert.deepEqual(await res.json(), { version: sha('# SPEC\nEDITED\n'), text: '# SPEC\nEDITED\n' });
  assert.equal(await readFile(spec, 'utf8'), '# SPEC\nEDITED\n');
  const raw = await put(e, { path: 'docs/spec.md', text: 'as typed\n', version: sha('# SPEC\nEDITED\n'), format: false });
  assert.deepEqual(await raw.json(), { version: sha('as typed\n') });
  const off = await startEditor(t, { editor: formats([UPPER], false) });
  const sent = await put(off, { path: 'docs/spec.md', text: 'as typed\n', version: sha(SPEC), format: true });
  assert.deepEqual(await sent.json(), { version: sha('as typed\n') });
});

test('a failed format writes the text as sent and answers formatError with its console run, which holds the header, the stderr and the reason (#749)', async (t) => {
  const e = await startEditor(t, { editor: formats([BROKEN]) });
  const answer = (await (await put(e, { path: 'docs/spec.md', text: 'mine\n', version: sha(SPEC), format: true })).json()) as FileSaved;
  assert.equal(answer.version, sha('mine\n'));
  assert.equal(answer.formatError, 'exit code 3');
  assert.equal(answer.formatLog?.channel, 'format:hive:broken');
  assert.equal(await readFile(join(e.worktree, 'docs', 'spec.md'), 'utf8'), 'mine\n');
  const view = (await (await hiveFetch(`${e.base}/console/${encodeURIComponent('format:hive:broken')}`)).json()) as ChannelView;
  assert.match(view.history, /── #HIVE-1 · docs\/spec\.md · \d\d:\d\d:\d\d ──/);
  assert.match(view.history, /no config found/);
  assert.match(view.history, /exit code 3/);
});

test('a stale version still answers 409 after formatting, the file untouched (#749)', async (t) => {
  const e = await startEditor(t, { editor: formats([UPPER]) });
  const spec = join(e.worktree, 'docs', 'spec.md');
  await writeFile(spec, 'an agent wrote this');
  const res = await put(e, { path: 'docs/spec.md', text: 'mine', version: sha(SPEC), format: true });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'o arquivo mudou no disco', version: sha('an agent wrote this') });
  assert.equal(await readFile(spec, 'utf8'), 'an agent wrote this');
});

test('GET /settings/formatters answers each supported formatter with the workspaces whose checkout has it; format on save out of scope writes the text as sent (#780)', async (t) => {
  const e = await startEditor(t, { editor: { ...formats([UPPER]), formatOnSave: { enabled: true, workspaces: [] } } });
  const prettier = join(e.repo, 'node_modules', '.bin', 'prettier');
  await mkdir(dirname(prettier), { recursive: true });
  await writeFile(prettier, '#!/bin/sh\ncat\n');
  await chmod(prettier, 0o755);
  const states = (await (await hiveFetch(`${e.base}/settings/formatters`)).json()) as FormatterState[];
  assert.deepEqual(states.map((s) => s.id), [...FORMATTER_IDS]);
  assert.deepEqual(states.find((s) => s.id === 'prettier')?.found, ['hive']);
  const sent = await put(e, { path: 'docs/spec.md', text: 'as typed\n', version: sha(SPEC), format: true });
  assert.deepEqual(await sent.json(), { version: sha('as typed\n') });
});

test('GET image answers the file\'s bytes with its extension\'s type, in any case, no-store, nosniff and a sandbox CSP, over 1 MB too (#498)', async (t) => {
  const e = await startEditor(t); // the worktree sits under .hive/: sendFile must allow dotfiles
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const big = Buffer.concat([PNG, Buffer.alloc(EDITOR_FILE_MAX)]);
  await writeFile(join(e.worktree, 'shot.PNG'), PNG);
  await writeFile(join(e.worktree, 'logo.svg'), svg);
  await writeFile(join(e.worktree, 'big.webp'), big);
  const png = await get(e, 'shot.PNG', 'image');
  assert.equal(png.status, 200);
  const headers = ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy'].map((name) => png.headers.get(name));
  assert.deepEqual(headers, ['image/png', 'no-store', 'nosniff', 'sandbox']);
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  const vector = await get(e, 'logo.svg', 'image');
  assert.deepEqual([vector.headers.get('content-type'), await vector.text()], ['image/svg+xml', svg]);
  const large = await get(e, 'big.webp', 'image');
  assert.deepEqual([large.status, large.headers.get('content-type'), (await large.arrayBuffer()).byteLength], [200, 'image/webp', big.length]);
});

test('GET image refuses a file that is not an image with a 415, a missing one with a 404 and no path with a 400 (#498)', async (t) => {
  const e = await startEditor(t);
  await writeFile(join(e.worktree, 'notes.txt'), 'notes\n');
  const cases: [string, number, string][] = [['notes.txt', 415, BINARY], ['docs/spec.md', 415, BINARY], ['nope.png', 404, MISSING], ['', 400, NO_PATH]];
  for (const [path, status, error] of cases) {
    const res = await get(e, path, 'image');
    assert.equal(res.status, status, path);
    assert.deepEqual(await res.json(), { error }, path);
  }
});
