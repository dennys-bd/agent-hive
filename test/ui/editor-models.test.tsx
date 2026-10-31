import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as models from '@/lib/editor-models';
import { setWriteGate, WriteCancelled } from '@/lib/api';
import * as fileBase from '@/lib/file-base';
import { jsonResponse } from '../fakes';
import { FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const A = 'a-I1';
const PATH = 'src/a.ts';
// What the disk answers: the file's read, and the next save's answer
let disk = { text: 'one\n', version: 'v1' };
let saved: (() => Response) | undefined;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return saved?.() ?? jsonResponse({ version: 'v2' });
  if (url.includes('missing')) return jsonResponse({ error: 'arquivo binário ou fora de UTF-8' }, 415);
  return jsonResponse({ path: PATH, ...disk });
});
const fake = async (activityId = A, path = PATH): Promise<FakeModel> => (await models.open(activityId, path)) as unknown as FakeModel;
const puts = (): unknown[] => fetchMock.mock.calls.flatMap(([, init]) => (init?.method === 'PUT' ? [JSON.parse(String(init.body))] : []));
const state = (): [boolean, string | undefined] => [models.isDirty(A, PATH), models.baseOf(A, PATH)];
// A pane's editor as attachView receives it: Monaco's, which reveals and keeps its view state (#551)
const editorView = () => ({
  setPosition: vi.fn(), revealPositionInCenter: vi.fn(), focus: vi.fn(),
  saveViewState: vi.fn(() => ({ scrollTop: 40 })), restoreViewState: vi.fn(),
});

beforeEach(() => {
  disk = { text: 'one\n', version: 'v1' };
  saved = undefined;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  setWriteGate(undefined);
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('open reads the file once and keeps one model per activity and path, its language from the extension or the file\'s name (#717)', async () => {
  const [first, again] = await Promise.all([models.open(A, PATH), models.open(A, PATH)]);
  expect(first).toBe(again);
  expect(await models.open(A, PATH)).toBe(first);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/activities/a-I1/file?path=src%2Fa.ts']);
  expect((first as unknown as FakeModel).language).toBe('typescript');
  expect((await fake(A, 'Dockerfile')).language).toBe('dockerfile');
  expect((await fake(A, 'notes.xyz')).language).toBe('plaintext');
  expect(state()).toEqual([false, 'v1']);
});

test('a read the pane cannot hold rejects with its status and the server\'s words, and leaves no model (#717)', async () => {
  await expect(models.open(A, 'missing.bin')).rejects.toMatchObject({ status: 415, message: 'arquivo binário ou fora de UTF-8' });
  expect(models.baseOf(A, 'missing.bin')).toBeUndefined();
});

test('typing makes the buffer dirty; a save PUTs the text over the base it read, then reads clean on the new version (#717)', async () => {
  const model = await fake();
  expect([models.isDirty(A, PATH), models.anyDirty()]).toEqual([false, false]);
  model.type('two\n');
  expect([models.isDirty(A, PATH), models.anyDirty()]).toEqual([true, true]);
  expect(await models.save(A, PATH, false)).toEqual({ status: 'saved' });
  expect(puts()).toEqual([{ path: PATH, text: 'two\n', version: 'v1', format: false }]);
  expect(state()).toEqual([false, 'v2']);
});

test('a save the disk refused is a conflict with the disk\'s version, any other refusal an error with its words; the buffer stays dirty on its base (#717)', async () => {
  (await fake()).type('two\n');
  saved = () => jsonResponse({ error: 'o arquivo mudou no disco', version: 'v9' }, 409);
  expect(await models.save(A, PATH, false)).toEqual({ status: 'conflict', version: 'v9' });
  saved = () => jsonResponse({ error: 'disco cheio' }, 500);
  expect(await models.save(A, PATH, false)).toEqual({ status: 'error', message: 'disco cheio' });
  expect(state()).toEqual([true, 'v1']);
});

test('reload takes the disk\'s text as one edit, the view\'s cursor and scroll kept, and reads clean on the disk\'s version (#717)', async () => {
  const model = await fake();
  disk = { text: 'from the agent\n', version: 'v3' };
  const view = { saveViewState: vi.fn(() => ({ scrollTop: 40 })), restoreViewState: vi.fn() };
  await models.reload(A, PATH, view);
  expect(model.getValue()).toBe('from the agent\n');
  expect(view.restoreViewState).toHaveBeenCalledWith({ scrollTop: 40 });
  expect(state()).toEqual([false, 'v3']);
});

test('keep mine takes the disk\'s version as the base and leaves the buffer dirty, so the next save overwrites it (#717)', async () => {
  (await fake()).type('mine\n');
  models.keepMine(A, PATH, 'v9');
  expect(state()).toEqual([true, 'v9']);
  await models.save(A, PATH, false);
  expect(puts()).toEqual([{ path: PATH, text: 'mine\n', version: 'v9', format: false }]);
});

test('close disposes the model and forgets it; closeExcept drops every model of an activity no longer listed, a dirty one too, and anyDirty follows (#717)', async () => {
  const kept = await fake();
  const gone = await fake('a-I2', 'b.ts');
  gone.type('unsaved');
  const listener = vi.fn();
  const stop = models.subscribe(listener);
  expect(models.anyDirty()).toBe(true);
  models.closeExcept(new Set([A]));
  expect([gone.disposed, kept.disposed, models.anyDirty(), models.baseOf('a-I2', 'b.ts')]).toEqual([true, false, false, undefined]);
  models.close(A, PATH);
  expect([kept.disposed, models.baseOf(A, PATH)]).toEqual([true, undefined]);
  expect(listener).toHaveBeenCalled();
  stop();
  await models.open(A, PATH);
  expect(fetchMock).toHaveBeenCalledTimes(3); // a closed file reads again
});

test('a reveal waits for the file\'s editor when none shows it, and lands at once when one does (#717)', () => {
  models.revealAt(A, PATH, { line: 3 });
  const view = editorView();
  const detach = models.attachView(A, PATH, view);
  expect(view.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 1 });
  models.revealAt(A, PATH, { line: 9, col: 4 });
  expect(view.revealPositionInCenter).toHaveBeenLastCalledWith({ lineNumber: 9, column: 4 });
  detach();
  models.revealAt(A, PATH, { line: 1 });
  expect(view.setPosition).toHaveBeenCalledTimes(2);
  models.close(A, PATH); // the waiting reveal goes with the file
});

test('a BOM the file opens with is written back on save, though the model\'s text does not show it (#717)', async () => {
  disk = { text: '\uFEFFone\n', version: 'v1' };
  const model = await fake();
  expect(model.getValue()).toBe('one\n');
  model.type('two\n');
  await models.save(A, PATH, false);
  expect(puts()).toEqual([{ path: PATH, text: '\uFEFFtwo\n', version: 'v1', format: false }]);
});

test('a reload whose buffer was typed in while the read flew keeps the typing and answers changed with the disk\'s version; an untouched one reloads (#717)', async () => {
  const model = await fake();
  disk = { text: 'from the agent\n', version: 'v3' };
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ path: PATH, ...disk });
  });
  const pending = models.reload(A, PATH);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  model.type('typed meanwhile\n');
  release();
  expect(await pending).toEqual({ status: 'changed', version: 'v3' });
  expect([model.getValue(), ...state()]).toEqual(['typed meanwhile\n', true, 'v1']);
  expect(await models.reload(A, PATH)).toEqual({ status: 'reloaded' });
  expect([model.getValue(), ...state()]).toEqual(['from the agent\n', false, 'v3']);
});

test('a tab closed while its file is still reading leaves no model: the one the read made is disposed, not registered (#717)', async () => {
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ path: PATH, ...disk });
  });
  const opening = models.open(A, PATH);
  const outcome = opening.then(() => 'opened', () => 'cancelled');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  models.close(A, PATH);
  release();
  expect(await outcome).toBe('cancelled');
  expect([models.baseOf(A, PATH), models.anyDirty()]).toEqual([undefined, false]);
  expect(FakeModel.all.every((m) => m.disposed)).toBe(true);
});

test('a formatted answer replaces a buffer left as it was sent, the view kept, and reads clean on the new version (#749)', async () => {
  const model = await fake();
  model.type('a=1\n');
  saved = () => jsonResponse({ version: 'v2', text: 'a = 1\n' });
  const view = { saveViewState: vi.fn(() => ({ scrollTop: 40 })), restoreViewState: vi.fn() };
  expect(await models.save(A, PATH, true, view)).toEqual({ status: 'saved' });
  expect(puts()).toEqual([{ path: PATH, text: 'a=1\n', version: 'v1', format: true }]);
  expect([model.getValue(), ...state()]).toEqual(['a = 1\n', false, 'v2']);
  expect(view.restoreViewState).toHaveBeenCalledWith({ scrollTop: 40 });
});

test('a buffer typed in while the formatting save flew keeps its text, dirty on the written version (#749)', async () => {
  const model = await fake();
  model.type('b=2\n');
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ version: 'v3', text: 'b = 2\n' });
  });
  const pending = models.save(A, PATH, true);
  await vi.waitFor(() => expect(puts()).toHaveLength(1));
  model.type('b=2\nc=3\n');
  release();
  await pending;
  expect([model.getValue(), ...state()]).toEqual(['b=2\nc=3\n', true, 'v3']);
});

test('a failed format comes back as saved with its reason and console run; a formatted text keeps the file\'s BOM apart (#749)', async () => {
  disk = { text: '\uFEFFone\n', version: 'v1' };
  const model = await fake();
  model.type('x\n');
  saved = () => jsonResponse({ version: 'v2', formatError: 'exit code 2', formatLog: { channel: 'format:hive:ruff', run: 'r1' } });
  expect(await models.save(A, PATH, true)).toEqual({ status: 'saved', formatError: 'exit code 2', formatLog: { channel: 'format:hive:ruff', run: 'r1' } });
  model.type('y\n');
  saved = () => jsonResponse({ version: 'v3', text: '\uFEFFY\n' });
  await models.save(A, PATH, true);
  expect([model.getValue(), model.getValue(undefined, true)]).toEqual(['Y\n', '\uFEFFY\n']);
});

test('a model asks Monaco\'s setup to paint it with its language\'s syntax package (#780)', async () => {
  const { monacoModule } = await import('./monaco-fake');
  await models.open('a-I1', 'src/x.py');
  expect(monacoModule.applied).toEqual([['python', 'src/x.py']]);
});

test('renamed re-keys every open buffer at the path or under a renamed folder, a dirty one kept, and tells its listeners (#818)', async () => {
  const model = await fake(A, 'src/a.ts');
  const other = await fake(A, 'README.md');
  model.type('mine');
  const heard: string[][] = [];
  const stop = models.onRenamed((...args) => heard.push(args));
  models.renamed(A, 'src', 'lib');
  stop();
  expect([models.isDirty(A, 'lib/a.ts'), models.isDirty(A, 'src/a.ts'), models.textOf(A, 'lib/a.ts')]).toEqual([true, false, 'mine']);
  expect(await models.open(A, 'lib/a.ts')).toBe(model);
  expect([model.disposed, models.textOf(A, 'README.md')]).toEqual([false, other.getValue()]);
  expect(heard).toEqual([[A, 'src', 'lib']]);
});

test('renamed carries the file\'s base pick to the new path, as it does the view, so the panes keep their base (#818)', async () => {
  await fake(A, 'src/a.ts');
  fileBase.choose(A, 'src/a.ts', 'task');
  models.renamed(A, 'src', 'lib');
  expect([fileBase.chosenBase(A, 'lib/a.ts'), fileBase.chosenBase(A, 'src/a.ts')]).toEqual(['task', 'head']);
  fileBase.choose(A, 'lib/a.ts', 'head');
});

test('isImagePath reads IMAGE_TYPES by the extension, in any case; readImage reads the image route, a refusal rejecting with its status and words (#498)', async () => {
  expect(['a.png', 'b/C.JPG', 'd.jpeg', 'e.gif', 'f.webp', 'g.SVG'].map((path) => models.isImagePath(path))).toEqual(new Array<boolean>(6).fill(true));
  expect(['a.ico', 'png', '.png', 'a.png.txt', 'src/a.ts'].map((path) => models.isImagePath(path))).toEqual(new Array<boolean>(5).fill(false));
  expect(models.fileUrl(A, 'shots/a.png', 'image')).toBe('/activities/a-I1/image?path=shots%2Fa.png');
  fetchMock.mockImplementationOnce(async () => new Response(new Uint8Array(3)));
  expect((await models.readImage(A, 'a.png')).size).toBe(3);
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/activities/a-I1/image?path=a.png');
  await expect(models.readImage(A, 'missing.png')).rejects.toMatchObject({ status: 415, message: 'arquivo binário ou fora de UTF-8' });
});

test('in run mode a save waits on the gate: a cancel PUTs nothing and the buffer stays dirty; an approve PUTs the text typed meanwhile (#469)', async () => {
  const model = await fake();
  model.type('two\n');
  let answer: ((isApproved: boolean) => void) | undefined;
  setWriteGate({ ask: () => new Promise<void>((resolve, reject) => { answer = (ok) => (ok ? resolve() : reject(new WriteCancelled('cancelled'))); }), written: () => undefined });
  const cancelled = models.save(A, PATH, false);
  answer?.(false);
  await expect(cancelled).rejects.toBeInstanceOf(WriteCancelled);
  expect([puts(), models.isDirty(A, PATH)]).toEqual([[], true]);
  const approved = models.save(A, PATH, false);
  model.type('three\n');
  answer?.(true);
  expect(await approved).toEqual({ status: 'saved' });
  expect(puts()).toEqual([{ path: PATH, text: 'three\n', version: 'v1', format: false }]);
  expect(state()).toEqual([false, 'v2']);
});

test('seed makes a moved buffer\'s model from its text over its base, dirty with no read, and the next save PUTs that base and its BOM (#551)', async () => {
  await models.seed(A, PATH, '\uFEFFmine\n', 'v7');
  expect([models.textOf(A, PATH), models.textOf(A, PATH, true), ...state()]).toEqual(['mine\n', '\uFEFFmine\n', true, 'v7']);
  expect(fetchMock).not.toHaveBeenCalled(); // the text came with the tab
  await models.save(A, PATH, false);
  expect(puts()).toEqual([{ path: PATH, text: '\uFEFFmine\n', version: 'v7', format: false }]);
});

test('seed over an open model replaces its text as one edit in the same model and takes the carried base, dirty (#551)', async () => {
  const model = await fake();
  await models.seed(A, PATH, 'mine\n', 'v7');
  expect(await models.open(A, PATH)).toBe(model);
  expect([model.getValue(), ...state()]).toEqual(['mine\n', true, 'v7']);
});

test('seed while the file\'s read still flies waits for it, so the read never replaces the carried text (#551)', async () => {
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ path: PATH, ...disk });
  });
  const opening = models.open(A, PATH);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const seeding = models.seed(A, PATH, 'mine\n', 'v7');
  release();
  await seeding;
  expect(await opening).toBe(await models.open(A, PATH));
  expect([models.textOf(A, PATH), ...state()]).toEqual(['mine\n', true, 'v7']);
});

test('restoreView lands at once on an attached editor, else on the next attach; renamed moves a waiting one and close drops it (#551)', async () => {
  await fake();
  models.restoreView(A, PATH, { scrollTop: 9 });
  models.renamed(A, PATH, 'src/b.ts');
  const moved = editorView();
  const detach = models.attachView(A, 'src/b.ts', moved);
  expect(moved.restoreViewState).toHaveBeenCalledWith({ scrollTop: 9 });
  expect(models.viewOf(A, 'src/b.ts')).toEqual({ scrollTop: 40 });
  models.restoreView(A, 'src/b.ts', { scrollTop: 3 });
  expect(moved.restoreViewState).toHaveBeenLastCalledWith({ scrollTop: 3 });
  detach();
  expect(models.viewOf(A, 'src/b.ts')).toBeUndefined();
  models.restoreView(A, 'src/b.ts', { scrollTop: 5 });
  models.close(A, 'src/b.ts');
  const again = editorView();
  models.attachView(A, 'src/b.ts', again)();
  expect(again.restoreViewState).not.toHaveBeenCalled();
});
