import { fireEvent, screen } from '@testing-library/react';
import type { editor } from 'monaco-editor';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import type { PeekMonaco } from '@/lib/change-peek';
import * as fileBase from '@/lib/file-base';
import { attachGutterMarks } from '@/lib/gutter-marks';
import { resetViewState } from '@/lib/view-state';
import { jsonResponse } from '../fakes';
import { FakeEditor, FakeModel, monacoModule, resetMonacoFakes } from './monaco-fake';

const FILE = { activityId: 'a-I1', path: 'src/a.ts' };
const BASE = 'a\nb\nc\nd\ne\nf\ng';
// b modified, e deleted, h added at the end
const CHANGED = 'a\nB\nc\nd\nf\ng\nh';
const monaco = monacoModule.monaco as unknown as PeekMonaco;
let base: unknown;

function attached(text: string): { view: FakeEditor; detach: () => void } {
  const host = document.body.appendChild(document.createElement('div'));
  const view = new FakeEditor(host, new FakeModel(text, 'typescript'), () => undefined, 'ui-monospace');
  return { view, detach: attachGutterMarks(monaco, view as unknown as editor.IStandaloneCodeEditor, FILE) };
}
const marksOf = (view: FakeEditor): [number, number, string | undefined][] =>
  view.decorations.map((d) => [d.range.startLineNumber, d.range.endLineNumber, d.options.linesDecorationsClassName]);

beforeEach(() => {
  setLanguage('pt');
  base = { against: 'head', label: 'HEAD', oid: 'o1', text: BASE };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(base)));
});
afterEach(() => {
  vi.useRealTimers();
  fileBase.closeExcept(new Set());
  resetMonacoFakes();
  resetViewState();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('once the base arrives a modified line gets the modify bar, a deletion the triangle on the line after it, an added line the add bar (#668)', async () => {
  const { view } = attached(CHANGED);
  expect(view.decorations).toEqual([]);
  await vi.waitFor(() => expect(marksOf(view)).toEqual([[2, 2, 'hive-change-modify'], [5, 5, 'hive-change-delete'], [7, 7, 'hive-change-add']]));
});

test('an edit recomputes the marks 300 ms after the last keystroke; the detach clears them and stops listening (#668)', async () => {
  const { view, detach } = attached(BASE);
  await vi.waitFor(() => expect(fileBase.baseOf(FILE.activityId, FILE.path)).toBeDefined());
  expect(view.decorations).toEqual([]);
  vi.useFakeTimers();
  view.model.type(`${BASE}\nh`);
  vi.advanceTimersByTime(299);
  expect(view.decorations).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(marksOf(view)).toEqual([[8, 8, 'hive-change-add']]);
  detach();
  expect(view.decorations).toEqual([]);
  view.model.type(CHANGED);
  vi.advanceTimersByTime(300);
  expect(view.decorations).toEqual([]);
});

test('a click on a mark opens the peek on its change; a click beside the marks does nothing (#668)', async () => {
  const { view } = attached(CHANGED);
  await vi.waitFor(() => expect(view.decorations).toHaveLength(3));
  view.clickGutter(3);
  expect(view.shownZones()).toEqual([]);
  view.clickGutter(5);
  expect(screen.getByText('2 de 3')).toBeInTheDocument();
  expect(view.shownZones().map((zone) => zone.afterLineNumber)).toEqual([4]);
});

test('a deletion\'s triangle straddles into the line above, so a click there opens its peek with the deleted lines (#668)', async () => {
  const { view } = attached(CHANGED);
  await vi.waitFor(() => expect(view.decorations).toHaveLength(3));
  view.clickGutter(4);
  expect([screen.getByText('2 de 3'), screen.getByText('- e')]).toEqual([expect.anything(), expect.anything()]);
});

test('a base with no text, outside a repository or a binary, marks nothing (#668)', async () => {
  base = { against: 'head', label: 'HEAD' };
  const { view } = attached(CHANGED);
  await vi.waitFor(() => expect(fileBase.baseOf(FILE.activityId, FILE.path)).toEqual({ against: 'head', label: 'HEAD' }));
  expect(view.decorations).toEqual([]);
});

test('a base that starts with a BOM does not mark line 1: Monaco holds the buffer\'s BOM apart (#668)', async () => {
  base = { against: 'head', label: 'HEAD', oid: 'o1', text: `\uFEFF${BASE}` };
  const { view } = attached(BASE);
  await vi.waitFor(() => expect(fileBase.baseOf(FILE.activityId, FILE.path)).toBeDefined());
  expect(view.decorations).toEqual([]);
});

test('reverting right after typing recomputes first, so the revert lands on the change as the buffer is now (#668)', async () => {
  const { view } = attached(CHANGED);
  await vi.waitFor(() => expect(view.decorations).toHaveLength(3));
  view.clickGutter(2);
  vi.useFakeTimers();
  view.model.type(`x\n${CHANGED}`);
  const push = vi.spyOn(view.model, 'pushEditOperations');
  fireEvent.click(screen.getByRole('button', { name: 'reverter este trecho' }));
  expect(push.mock.calls[0][1]).toEqual([{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 }, text: 'b\n' }]);
});
