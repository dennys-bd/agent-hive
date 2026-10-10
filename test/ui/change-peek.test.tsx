import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { editor } from 'monaco-editor';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { openPeek, type PeekMonaco, revertEdit } from '@/lib/change-peek';
import type { LineChange } from '@/lib/line-changes';
import { FAKE_LINE_HEIGHT, FakeEditor, FakeModel, type FakeZone, monacoModule, resetMonacoFakes } from './monaco-fake';

const monaco = monacoModule.monaco as unknown as PeekMonaco;
// 'a\nb\nc' became 'a\nB\nc\nx': line 2 modified, line 4 added
const CHANGES: LineChange[] = [{ kind: 'modify', start: 2, end: 3, baseStart: 2, baseEnd: 3 }, { kind: 'add', start: 4, end: 5, baseStart: 4, baseEnd: 4 }];
const range = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn });
const columnsOf = (lines: string[]) => (line: number): number => lines[line - 1].length + 1;

function opened(): { view: FakeEditor; model: FakeModel; onClose: () => void; peek: ReturnType<typeof openPeek> } {
  const host = document.body.appendChild(document.createElement('div'));
  const model = new FakeModel('a\nB\nc\nx', 'typescript');
  const view = new FakeEditor(host, model, () => undefined, 'ui-monospace');
  const onClose = vi.fn();
  const peek = openPeek(monaco, view as unknown as editor.IStandaloneCodeEditor, { changes: CHANGES, index: 0, baseText: 'a\nb\nc' }, onClose);
  return { view, model, onClose, peek };
}
const zoneLines = (view: FakeEditor): number[] => view.shownZones().map((zone) => zone.afterLineNumber);

beforeEach(() => { setLanguage('pt'); });
afterEach(() => {
  resetMonacoFakes();
  document.body.replaceChildren();
});

test('revertEdit writes the base\'s lines over the change\'s, line breaks included, at the end of the file too (#668)', () => {
  expect(revertEdit({ kind: 'add', start: 2, end: 3, baseStart: 2, baseEnd: 2 }, ['a', 'b'], 3, columnsOf(['a', 'x', 'b']), '\n')).toEqual({ range: range(2, 1, 3, 1), text: '' });
  expect(revertEdit({ kind: 'delete', start: 2, end: 2, baseStart: 2, baseEnd: 3 }, ['a', 'b', 'c'], 2, columnsOf(['a', 'c']), '\n')).toEqual({ range: range(2, 1, 2, 1), text: 'b\n' });
  expect(revertEdit({ kind: 'add', start: 3, end: 4, baseStart: 3, baseEnd: 3 }, ['a', 'b'], 3, columnsOf(['a', 'b', 'x']), '\n')).toEqual({ range: range(2, 2, 3, 2), text: '' });
  expect(revertEdit({ kind: 'delete', start: 2, end: 2, baseStart: 2, baseEnd: 3 }, ['a', 'b'], 1, columnsOf(['a']), '\n')).toEqual({ range: range(1, 2, 1, 2), text: '\nb' });
  expect(revertEdit({ kind: 'modify', start: 2, end: 3, baseStart: 2, baseEnd: 3 }, ['a', 'b'], 2, columnsOf(['a', 'B']), '\r\n')).toEqual({ range: range(2, 1, 2, 2), text: 'b' });
  expect(revertEdit({ kind: 'add', start: 1, end: 3, baseStart: 1, baseEnd: 1 }, [''], 2, columnsOf(['x', 'y']), '\n')).toEqual({ range: range(1, 1, 2, 2), text: '' });
});

test('the peek sits under its change as an inline diff of its base lines over its lines now, in the editor\'s font; reverter este trecho writes them back as one edit and closes it (#668)', async () => {
  const user = userEvent.setup();
  const { view, model, onClose } = opened();
  expect(zoneLines(view)).toEqual([2]);
  expect(screen.getByText('1 de 2')).toBeInTheDocument();
  const [old, now] = [screen.getByText('- b'), screen.getByText('+ B')];
  expect([old.style.fontFamily, old.style.height, now.style.height, now.className]).toEqual(['ui-monospace', `${FAKE_LINE_HEIGHT}px`, `${FAKE_LINE_HEIGHT}px`, expect.stringContaining('bg-working/12')]);
  const edits = vi.spyOn(model, 'pushEditOperations');
  await user.click(screen.getByRole('button', { name: 'reverter este trecho' }));
  expect(edits.mock.calls).toEqual([[[], [{ range: range(2, 1, 3, 1), text: 'b\n' }], expect.any(Function)]]);
  expect([zoneLines(view), vi.mocked(onClose).mock.calls.length]).toEqual([[], 1]);
});

test('the peek is an overlay widget over an empty zone, so its buttons take their own clicks; it follows the zone\'s top and height (#668)', () => {
  const { view } = opened();
  const [zone] = view.shownZones() as (FakeZone & { onDomNodeTop(top: number): void; onComputedHeight(height: number): void })[];
  const peek = screen.getByText('1 de 2').closest('div.border-y') as HTMLElement;
  expect([zone.domNode.contains(peek), peek.style.left, peek.style.width]).toEqual([false, '60px', '786px']);
  zone.onDomNodeTop(120);
  zone.onComputedHeight(72);
  expect([peek.style.top, peek.style.height]).toEqual(['120px', '72px']);
});

test('next and previous move the peek through the file\'s changes, around the ends; an add shows its lines with no base line (#668)', async () => {
  const user = userEvent.setup();
  const { view } = opened();
  await user.click(screen.getByRole('button', { name: 'próxima alteração' }));
  expect([screen.getByText('2 de 2'), zoneLines(view), screen.getByText('+ x'), screen.queryByText(/^- /)]).toEqual([expect.anything(), [4], expect.anything(), null]);
  await user.click(screen.getByRole('button', { name: 'próxima alteração' }));
  expect([screen.getByText('1 de 2'), zoneLines(view)]).toEqual([expect.anything(), [2]]);
  await user.click(screen.getByRole('button', { name: 'alteração anterior' }));
  expect([screen.getByText('2 de 2'), zoneLines(view)]).toEqual([expect.anything(), [4]]);
});

test('Esc in the editor or in the peek closes it, as fechar does; an edit that moves its change moves it, one that removes it closes it (#668)', async () => {
  const user = userEvent.setup();
  const first = opened();
  first.view.pressKey('Escape');
  expect([zoneLines(first.view), vi.mocked(first.onClose).mock.calls.length]).toEqual([[], 1]);
  resetMonacoFakes();
  const second = opened();
  fireEvent.keyDown(screen.getByText('1 de 2'), { key: 'Escape' });
  expect(zoneLines(second.view)).toEqual([]);
  const third = opened();
  third.peek.update([{ kind: 'modify', start: 3, end: 4, baseStart: 2, baseEnd: 3 }, CHANGES[1]]);
  expect(zoneLines(third.view)).toEqual([3]);
  third.peek.update([CHANGES[1]]);
  expect([zoneLines(third.view), vi.mocked(third.onClose).mock.calls.length]).toEqual([[], 1]);
  const fourth = opened();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(zoneLines(fourth.view)).toEqual([]);
});
