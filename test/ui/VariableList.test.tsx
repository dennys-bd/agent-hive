import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { setVariableValue } from '../../src/template-edit';
import { VariableList } from '@/components/plugins/VariableList';
import type { WriteResult } from '@/hooks/use-item-editor';
import { setLanguage } from '@/i18n';

// A protocol passage's text (#337): `after:` beside `variables:`, the header the list edits
const TEXT = '---\nafter: ask\nvariables:\n  docsRepo: { default: null }\n---\nSee {{ docsRepo }}.\n';

beforeEach(() => setLanguage('pt'));

test('VariableList works on any text: no origin and no lint line when none is given, and every write goes through onApply (#337)', async () => {
  const user = userEvent.setup();
  const onApply = vi.fn((_result: WriteResult) => undefined);
  render(<VariableList text={TEXT} workspaces={['agent-hive', 'hive-site']} onApply={onApply} />);
  const row = screen.getByRole('listitem', { name: 'docsRepo' });
  expect(within(row).queryByText(/^(da hive|sua)$/)).not.toBeInTheDocument();
  expect(within(row).queryByText(/falta|nunca usada/)).not.toBeInTheDocument();
  await user.click(within(row).getByLabelText('docsRepo · hive-site'));
  await user.type(within(row).getByRole('textbox', { name: 'docsRepo · hive-site' }), 'site-docs{Enter}');
  const written = setVariableValue(TEXT, 'docsRepo', 'hive-site', 'site-docs');
  if (!written.ok) throw new Error(written.error.message);
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0][0]).toMatchObject({ ok: true, text: written.text });
});

test('a variable from the task reads "da tarefa" as its origin and as every workspace\'s value, with no control to write one (#492)', () => {
  const text = '---\nname: x\nvariables:\n  planPath: { from: task }\n---\n{{ planPath }}\n';
  render(<VariableList text={text} workspaces={['agent-hive', 'hive-site']} onApply={() => undefined} originOf={() => 'yours'} />);
  const row = screen.getByRole('listitem', { name: 'planPath' });
  expect(within(row).getAllByText('da tarefa')).toHaveLength(3);
  for (const value of within(row).getAllByText('da tarefa').slice(1)) expect(value).toHaveClass('text-muted-foreground');
  expect(within(row).queryByLabelText('planPath · agent-hive')).not.toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'remover planPath' })).toBeInTheDocument();
});
