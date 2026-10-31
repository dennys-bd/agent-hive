import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as models from '@/lib/editor-models';
import { applyCarry, takeCarry } from '@/lib/tab-carry';
import { type CenterTabRef, parseMovedTab } from '../../src/tab-carry';
import { jsonResponse } from '../fakes';
import { type FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const A = 'a-I1';
const PATH = 'src/a.ts';
const FILE: CenterTabRef = { kind: 'file', path: PATH };
const VIEW_STATE = { cursorState: [], viewState: { scrollTop: 40 } };
// The disk holds the file with a BOM, so a carry shows it keeps one (spec decision 8)
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
  (init?.method === 'PUT' ? jsonResponse({ version: 'v2' }) : jsonResponse({ path: PATH, text: '﻿one\n', version: 'v1' })));
const puts = (): unknown[] => fetchMock.mock.calls.flatMap(([, init]) => (init?.method === 'PUT' ? [JSON.parse(String(init.body))] : []));
const typeIn = async (path: string, text: string): Promise<void> => ((await models.open(A, path)) as unknown as FakeModel).type(text);
const buffer = (path: string): [boolean, string | undefined, string | undefined] => [models.isDirty(A, path), models.textOf(A, path), models.baseOf(A, path)];
const editorView = () => ({
  setPosition: vi.fn(), revealPositionInCenter: vi.fn(), focus: vi.fn(), saveViewState: vi.fn(() => VIEW_STATE), restoreViewState: vi.fn(),
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('takeCarry of a dirty file takes its text with its BOM, its base, and the attached editor\'s view state (#551)', async () => {
  await typeIn(PATH, 'mine\n');
  const detach = models.attachView(A, PATH, editorView());
  expect(takeCarry(A, FILE)).toEqual({ text: '﻿mine\n', base: 'v1', viewState: VIEW_STATE });
  detach();
  expect(takeCarry(A, FILE)).toEqual({ text: '﻿mine\n', base: 'v1' });
});

test('takeCarry answers nothing for a clean file and for a run, diff, preview, console or design tab (#551)', async () => {
  await typeIn(PATH, 'mine\n');
  await models.open(A, 'src/clean.ts');
  const refs: CenterTabRef[] = [
    { kind: 'file', path: 'src/clean.ts' }, { kind: 'run', ptyId: 'p1' }, { kind: 'diff', scope: 'worktree' },
    { kind: 'preview', path: PATH }, { kind: 'console' }, { kind: 'design', path: PATH },
  ];
  expect(refs.map((ref) => takeCarry(A, ref))).toEqual(refs.map(() => undefined));
});

test('applyCarry seeds the file dirty with the carried text over the carried base and answers the ref; the next save PUTs that base (#551)', async () => {
  expect(await applyCarry(A, FILE, { text: 'mine\n', base: 'v7' })).toEqual(FILE);
  expect(buffer(PATH)).toEqual([true, 'mine\n', 'v7']);
  await models.save(A, PATH, false);
  expect(puts()).toEqual([{ path: PATH, text: 'mine\n', version: 'v7', format: false }]);
});

test('applyCarry with no carry seeds nothing and answers the ref (#551)', async () => {
  expect(await applyCarry(A, FILE)).toEqual(FILE);
  expect(models.baseOf(A, PATH)).toBeUndefined();
});

test('applyCarry over a model already open replaces its text in the same model and leaves it dirty on the carried base (#551)', async () => {
  const model = await models.open(A, PATH);
  await applyCarry(A, { kind: 'changes', path: PATH }, { text: 'mine\n', base: 'v7' });
  expect(await models.open(A, PATH)).toBe(model);
  expect(buffer(PATH)).toEqual([true, 'mine\n', 'v7']);
});

test('the carried view state is restored when an editor next attaches to the model (#551)', async () => {
  await applyCarry(A, FILE, { text: 'mine\n', base: 'v7', viewState: VIEW_STATE });
  const view = editorView();
  models.attachView(A, PATH, view)();
  expect(view.restoreViewState).toHaveBeenCalledWith(VIEW_STATE);
});

test('an untitled tab whose number is already open here is renumbered, and the buffer that held the number keeps its text (#551)', async () => {
  const n = models.nextUntitled();
  await typeIn(models.untitledPath(n), 'here');
  const answered = await applyCarry(A, { kind: 'untitled', n }, { text: 'moved', base: '' });
  expect(answered).toEqual({ kind: 'untitled', n: n + 1 });
  expect([models.textOf(A, models.untitledPath(n)), buffer(models.untitledPath(n + 1))]).toEqual(['here', [true, 'moved', '']]);
});

test('a dirty file and an untitled buffer taken, checked by parseMovedTab, closed and applied come back dirty with the same text, with no read (#551)', async () => {
  await typeIn(PATH, 'mine\n');
  const n = models.nextUntitled();
  const untitled: CenterTabRef = { kind: 'untitled', n };
  const draft = models.untitledPath(n);
  await typeIn(draft, 'draft');
  const moved = [FILE, untitled].map((ref) => parseMovedTab(JSON.parse(JSON.stringify({ activity: A, ref, carry: takeCarry(A, ref) }))));
  expect(moved.every((tab) => tab?.carry !== undefined)).toBe(true);
  models.closeExcept(new Set());
  for (const tab of moved) if (tab !== undefined) expect(await applyCarry(tab.activity, tab.ref, tab.carry)).toEqual(tab.ref);
  expect([buffer(PATH), buffer(draft)]).toEqual([[true, 'mine\n', 'v1'], [true, 'draft', '']]);
  expect(fetchMock).toHaveBeenCalledTimes(1); // only the file's first open read the disk
});
