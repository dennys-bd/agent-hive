import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { EditResult } from '../../src/template-edit';
import { ChainCard } from '@/components/plugins/ChainCard';
import { setLanguage } from '@/i18n';
import type { FormVariable } from '@/lib/chain-draft';

// No declared variable: the form offers only the built-in workspace (decision 8)
const VARIABLES: FormVariable[] = [{ name: 'workspace', kind: 'list', values: ['agent-hive', 'hive-site'] }];
const REFUSED: EditResult = { ok: false, error: { line: 3, message: 'no' } };

beforeEach(() => setLanguage('pt'));

test('insert waits for a complete if, then sends its chain; a refusal shows its copy and keeps the card; Esc inside cancels (#322, decisions 8, 9, 12, 19, 20)', async () => {
  const user = userEvent.setup();
  const onInsert = vi.fn((): EditResult => REFUSED);
  const onClose = vi.fn();
  render(<ChainCard variables={VARIABLES} onInsert={onInsert} onClose={onClose} />);
  const card = screen.getByRole('region', { name: 'novo bloco condicional' });
  const insert = within(card).getByRole('button', { name: 'inserir' });
  expect(insert).toBeDisabled();
  expect(card).toHaveTextContent('nenhuma variável declarada');
  await user.click(within(card).getByRole('combobox', { name: 'variável' }));
  await user.click(await screen.findByRole('option', { name: 'workspace' }));
  await user.click(within(card).getByRole('combobox', { name: 'operador' }));
  await user.click(await screen.findByRole('option', { name: 'é' }));
  expect(insert).toBeDisabled();
  await user.click(within(card).getByRole('combobox', { name: 'valor' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await user.click(insert);
  expect(onInsert).toHaveBeenCalledWith({ branches: [{ connective: 'and', terms: [{ variable: 'workspace', op: 'is', value: 'hive-site' }] }], else: false });
  expect(within(card).getByRole('alert')).toHaveTextContent('não foi possível mudar o texto');
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(card, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
