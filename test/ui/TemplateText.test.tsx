import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { type MarginAnnotations, TemplateText, type TemplateTextProps } from '@/components/plugins/TemplateText';
import type { AgentAnnotation } from '../../src/reviewer';
import { REVIEWER_DEFAULTS } from '../../src/types';
import { setLanguage } from '@/i18n';
import { FAKE_LINE_HEIGHT, FakeEditor, FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const props = (extra: Partial<TemplateTextProps> = {}): TemplateTextProps => ({
  modelKey: 'hive:new-build\0SKILL.md.liquid', path: 'SKILL.md.liquid', text: 'a\nb\nc\n', isReadOnly: false, fontFamily: 'ui-monospace',
  hidden: [], decorations: [], chips: [], onChange: vi.fn(), onSave: vi.fn(), ...extra,
});
async function firstEditor(): Promise<FakeEditor> {
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  return FakeEditor.all[0]!;
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});

test("the buffer opens in a markdown model: typing reports the text, ⌘S saves, and a text from outside replaces the model's without being reported back (#319)", async () => {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const { rerender } = render(<TemplateText {...props({ onChange, onSave })} />);
  const view = await firstEditor();
  expect([view.model.getValue(), view.model.language]).toEqual(['a\nb\nc\n', 'markdown']);
  act(() => view.model.type('a\nB\nc\n'));
  expect(onChange).toHaveBeenLastCalledWith('a\nB\nc\n');
  view.onSave();
  view.onSaveUnformatted();
  expect(onSave).toHaveBeenCalledTimes(2);
  rerender(<TemplateText {...props({ onChange, onSave, text: 'moved\n' })} />);
  expect(view.model.getValue()).toBe('moved\n');
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('hidden areas, the marks and read-only follow the props; a new modelKey makes a new model in its language and disposes the old one (#319)', async () => {
  const decorations: TemplateTextProps['decorations'] = [{ line: 3, from: 1, to: 2, className: 'template-pill' }, { line: 2, className: 'template-branch', isBackground: true }];
  const { rerender } = render(<TemplateText {...props({ hidden: [{ from: 1, to: 2 }], decorations })} />);
  const view = await firstEditor();
  await waitFor(() => expect(view.hiddenAreas).toEqual([{ startLineNumber: 1, endLineNumber: 2 }]));
  expect(view.decorations.map((d) => [d.range.startLineNumber, d.options])).toEqual([[3, { inlineClassName: 'template-pill' }], [2, { isWholeLine: true, className: 'template-branch' }]]);
  rerender(<TemplateText {...props({ isReadOnly: true })} />);
  expect([view.readOnly, view.hiddenAreas, view.decorations]).toEqual([true, [], []]);
  rerender(<TemplateText {...props({ modelKey: 'other', path: 'scripts/run.py', text: 'print(1)\n' })} />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  expect([view.disposed, FakeModel.all[0]?.disposed, FakeModel.all[1]?.language]).toEqual([true, true, 'python']);
});

test("a reveal puts the cursor on its line; each chip sits at its line's top in the conditions column and answers onChip (#319, decisions 17, 19)", async () => {
  const onChip = vi.fn();
  const chips = [{ line: 3, label: 'if a' }];
  const { rerender } = render(<TemplateText {...props({ chips, onChip })} />);
  const view = await firstEditor();
  rerender(<TemplateText {...props({ chips, onChip, reveal: { line: 2, n: 1 } })} />);
  expect(view.position).toEqual({ lineNumber: 2, column: 1 });
  const chip = within(screen.getByRole('group', { name: 'condições' })).getByRole('button', { name: 'if a' });
  await waitFor(() => expect(chip).toHaveStyle({ top: `${2 * FAKE_LINE_HEIGHT}px` }));
  fireEvent.click(chip);
  expect(onChip).toHaveBeenCalledWith(3);
});

test('a swap into the proposal and back replaces the text with setValue and reports no change; any other new text stays one undoable edit (#331)', async () => {
  const onChange = vi.fn();
  const { rerender } = render(<TemplateText {...props({ onChange })} />);
  const view = await firstEditor();
  const setValue = vi.spyOn(view.model, 'setValue');
  const pushed = vi.spyOn(view.model, 'pushEditOperations');
  rerender(<TemplateText {...props({ onChange, isProposal: true, isReadOnly: true, text: 'a\nb\nB\nc\n' })} />);
  expect([view.model.getValue(), setValue.mock.calls.length, pushed.mock.calls.length]).toEqual(['a\nb\nB\nc\n', 1, 0]);
  rerender(<TemplateText {...props({ onChange, text: 'a\nb\nc\n' })} />);
  expect([view.model.getValue(), setValue.mock.calls.length]).toEqual(['a\nb\nc\n', 2]);
  rerender(<TemplateText {...props({ onChange, text: 'moved\n' })} />);
  expect([setValue.mock.calls.length, pushed.mock.calls.length]).toEqual([2, 1]);
  expect(onChange).not.toHaveBeenCalled();
});

test("a selection reports its first and last line; one ending at a line's first column leaves that line out; an empty one reports undefined (#331)", async () => {
  const onSelection = vi.fn();
  render(<TemplateText {...props({ onSelection })} />);
  const view = await firstEditor();
  act(() => view.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 }));
  act(() => view.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }));
  act(() => view.select({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }));
  expect(onSelection.mock.calls).toEqual([[{ startLine: 1, endLine: 2 }], [{ startLine: 1, endLine: 2 }], [undefined]]);
});

test('a note chip is plain text, not a button (#492)', async () => {
  render(<TemplateText {...props({ chips: [{ line: 3, label: 'if a' }, { line: 5, label: 'agent proposal', isNote: true }] })} />);
  await firstEditor();
  const column = within(screen.getByRole('group', { name: 'condições' }));
  expect(column.queryByRole('button', { name: 'agent proposal' })).toBeNull();
  expect(column.getByText('agent proposal')).toHaveClass('text-muted-foreground');
  expect(column.getByRole('button', { name: 'if a' })).toBeInTheDocument();
});

const agentAt = (line: number, severity: AgentAnnotation['severity']): AgentAnnotation => ({ line, severity, title: `t${line}${severity}`, body: 'b', source: 'agent', kind: 'advice' });
const annotationsOf = (list: readonly AgentAnnotation[]): MarginAnnotations => ({
  list, values: { variables: {}, builtIns: {} }, writeValue: vi.fn(), review:{ config: { ...REVIEWER_DEFAULTS, when: 'demand', version: 'strict' }, running: false, canReview: true, now: vi.fn(), set: vi.fn() },
  canDismiss: true, openAt: vi.fn(), next: vi.fn(), close: vi.fn(), dismiss: vi.fn(), apply: vi.fn(), passage: vi.fn(),
});
const glyphs = (view: FakeEditor) => view.decorations.filter((d) => d.options.glyphMarginClassName !== undefined).map((d) => [d.range.startLineNumber, d.options.glyphMarginClassName]);

test('with the margin closed the column is gone and each annotated line gets a dot, red over yellow; a click on a dot gives its line\'s first annotation; open, no dots (#980)', async () => {
  const onDot = vi.fn();
  const list = [agentAt(2, 'yellow'), agentAt(3, 'yellow'), agentAt(3, 'red')];
  const annotations = annotationsOf(list);
  const chips = [{ line: 1, label: 'if a' }];
  const { rerender } = render(<TemplateText {...props({ annotations, chips, isMarginOpen: false, onDot })} />);
  const view = await firstEditor();
  expect(screen.queryByRole('group', { name: 'anotações' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'condições' })).not.toBeInTheDocument();
  await waitFor(() => expect(glyphs(view)).toEqual([[2, 'template-glyph-yellow'], [3, 'template-glyph-red']]));
  view.clickGlyph(3);
  expect(onDot).toHaveBeenCalledWith(list[1]); // the line's first in list order
  view.clickGlyph(1); // no dot there
  view.clickGutter(2); // another gutter column
  expect(onDot).toHaveBeenCalledTimes(1);
  rerender(<TemplateText {...props({ annotations, chips, isMarginOpen: true, onDot })} />);
  expect(glyphs(view)).toEqual([]);
  expect(screen.getByRole('group', { name: 'anotações' })).toBeInTheDocument();
  view.clickGlyph(3);
  expect(onDot).toHaveBeenCalledTimes(1);
});

const jumps = (view: FakeEditor) => view.decorations.filter((d) => d.options.className === 'template-jump').map((d) => [d.range.startLineNumber, d.options.isWholeLine]);

test('a jump reveal paints its whole line until the caret moves, the text changes or another reveal comes; a plain reveal paints nothing (#982)', async () => {
  const { rerender } = render(<TemplateText {...props()} />);
  const view = await firstEditor();
  rerender(<TemplateText {...props({ reveal: { line: 2, n: 1, isJump: true } })} />);
  expect([view.position, jumps(view)]).toEqual([{ lineNumber: 2, column: 1 }, [[2, true]]]);
  act(() => view.setPosition({ lineNumber: 3, column: 1 }));
  expect(jumps(view)).toEqual([]);
  rerender(<TemplateText {...props({ reveal: { line: 3, n: 2, isJump: true } })} />);
  expect(jumps(view)).toEqual([[3, true]]);
  act(() => view.model.type('a\nb\nc\nd\n'));
  expect(jumps(view)).toEqual([]);
  rerender(<TemplateText {...props({ reveal: { line: 1, n: 3, isJump: true } })} />);
  expect(jumps(view)).toEqual([[1, true]]);
  rerender(<TemplateText {...props({ reveal: { line: 2, n: 4 } })} />);
  expect([view.position, jumps(view)]).toEqual([{ lineNumber: 2, column: 1 }, []]);
});

test("a jump selects nothing: the reveal's own move reports an empty selection (#982)", async () => {
  const onSelection = vi.fn();
  const { rerender } = render(<TemplateText {...props({ onSelection })} />);
  const view = await firstEditor();
  act(() => view.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 }));
  rerender(<TemplateText {...props({ onSelection, reveal: { line: 3, n: 1, isJump: true } })} />);
  expect(onSelection).toHaveBeenLastCalledWith(undefined);
});

test('select sets whole lines once per n, reported through onSelection; one with no lines collapses the selection to its start (#982)', async () => {
  const onSelection = vi.fn();
  const { rerender } = render(<TemplateText {...props({ onSelection })} />);
  const view = await firstEditor();
  rerender(<TemplateText {...props({ onSelection, select: { lines: { startLine: 1, endLine: 2 }, n: 1 } })} />);
  expect(view.selection).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 });
  expect(onSelection).toHaveBeenLastCalledWith({ startLine: 1, endLine: 2 });
  rerender(<TemplateText {...props({ onSelection, select: { lines: { startLine: 3, endLine: 3 }, n: 1 } })} />);
  expect(view.selection).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 }); // the same n applies once
  rerender(<TemplateText {...props({ onSelection, select: { n: 2 } })} />);
  expect(view.selection).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
  expect(onSelection).toHaveBeenLastCalledWith(undefined);
  const last = view.getModel().getLineCount();
  rerender(<TemplateText {...props({ onSelection, select: { lines: { startLine: last + 5, endLine: last + 9 }, n: 3 } })} />);
  // a stale line past the end is clamped to the last line, never thrown on
  expect(view.selection).toEqual({ startLineNumber: last, startColumn: 1, endLineNumber: last, endColumn: view.getModel().getLineMaxColumn(last) });
});
