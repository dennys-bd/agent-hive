import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TemplateText, type TemplateTextProps } from '@/components/plugins/TemplateText';
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
