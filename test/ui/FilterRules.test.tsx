import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { FilterRules } from '@/components/settings/FilterRules';
import { setLanguage } from '@/i18n';
import { NO_VALUE } from '../../src/task-filter';
import type { FilterRule } from '../../src/types';

beforeEach(() => setLanguage('pt'));

const LABEL: FilterRule = { field: 'label', op: 'none', values: ['wontfix'] };

test('bloqueado is always listed last, with no loaded options; choosing it keeps the operator and drops the values (#441)', async () => {
  const onChange = vi.fn();
  render(<FilterRules rules={[LABEL]} onChange={onChange} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'critério' })); // a plain click opens Radix reliably, as in TaskRules' tests
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['responsável', 'label', 'milestone', 'repositório', 'bloqueado']);
  fireEvent.click(screen.getByRole('option', { name: 'bloqueado' }));
  expect(onChange).toHaveBeenLastCalledWith([{ field: 'blocked', op: 'none' }]);
});

test('a blocked rule shows no values picker and reads está / não está; switching back to another criterion starts with no value (#441)', async () => {
  const onChange = vi.fn();
  const { rerender } = render(<FilterRules rules={[{ field: 'blocked', op: 'none' }]} onChange={onChange} />);
  const line = screen.getByTestId('filter-rule');
  expect(within(line).queryByRole('combobox', { name: 'valores' })).not.toBeInTheDocument();
  expect(within(line).getByRole('combobox', { name: 'operador' })).toHaveTextContent('não está');
  fireEvent.click(within(line).getByRole('combobox', { name: 'operador' }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['está', 'não está']);
  fireEvent.click(screen.getByRole('option', { name: 'está' }));
  expect(onChange).toHaveBeenLastCalledWith([{ field: 'blocked', op: 'any' }]);
  fireEvent.click(within(line).getByRole('combobox', { name: 'critério' }));
  fireEvent.click(await screen.findByRole('option', { name: 'label' }));
  expect(onChange).toHaveBeenLastCalledWith([{ field: 'label', op: 'none', values: [] }]);
  rerender(<FilterRules rules={[{ field: 'label', op: 'none', values: [] }]} onChange={onChange} />);
  const back = screen.getByTestId('filter-rule');
  expect(within(back).getByRole('combobox', { name: 'valores' })).toBeInTheDocument();
  expect(within(back).getByRole('combobox', { name: 'operador' })).toHaveTextContent('não é nenhum de');
});

test('nenhum is a value offered first, next to @me, and reads nenhum on its chip; an empty picker reads adicionar valor (#524)', async () => {
  const onChange = vi.fn();
  const { rerender } = render(<FilterRules rules={[{ field: 'assignee', op: 'any', values: [] }]} options={{ assignees: ['@me', 'ana'], labels: [], milestones: [], repositories: [], projectFields: [] }} onChange={onChange} />);
  const values = screen.getByRole('combobox', { name: 'valores' });
  expect(values).toHaveTextContent('adicionar valor');
  fireEvent.click(values);
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['nenhum', '@me', 'ana']);
  fireEvent.click(screen.getByRole('option', { name: 'nenhum' }));
  expect(onChange).toHaveBeenLastCalledWith([{ field: 'assignee', op: 'any', values: [NO_VALUE] }]);
  rerender(<FilterRules rules={[{ field: 'assignee', op: 'any', values: ['@me', NO_VALUE] }]} onChange={onChange} />);
  expect(screen.getByRole('combobox', { name: 'valores' })).toHaveTextContent('@menenhum');
});
