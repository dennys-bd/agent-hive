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

test('VariableList works on any text: no origin and no lint line when none is given, and with no workspace route every value is the text\'s own entry, through onApply (#337, #621)', async () => {
  const user = userEvent.setup();
  const onApply = vi.fn((_result: WriteResult) => undefined);
  render(<VariableList text={TEXT} workspaces={['agent-hive', 'hive-site']} onApply={onApply} />);
  const row = screen.getByRole('listitem', { name: 'docsRepo' });
  expect(within(row).queryByText(/^(da hive|sua)$/)).not.toBeInTheDocument();
  expect(within(row).queryByText(/falta|nunca usada/)).not.toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: 'editar docsRepo' }));
  const form = screen.getByRole('form', { name: 'editar docsRepo' });
  expect(within(form).queryByRole('group', { name: 'valor por workspace' })).not.toBeInTheDocument();
  await user.type(within(form).getByRole('textbox', { name: 'hive-site · só neste template' }), 'site-docs');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  const written = setVariableValue(TEXT, 'docsRepo', 'hive-site', 'site-docs');
  if (!written.ok) throw new Error(written.error.message);
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0][0]).toMatchObject({ ok: true, text: written.text });
});
