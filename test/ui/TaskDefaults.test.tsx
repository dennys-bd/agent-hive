import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskDefaults } from '@/components/settings/TaskDefaults';
import { setLanguage, t } from '@/i18n';
import type { SourceTaskPropsDraft } from '@/lib/setup-source-task-props';

beforeEach(() => setLanguage('pt'));

const DRAFT: SourceTaskPropsDraft = {
  defaults: { workspace: 'hive', auto: true },
  rules: [{ id: 'a', field: 'labels', op: 'icontains', value: 'core', set: { workspace: 'site' } }],
};

test('one row per property in registry order, with its note, its default and its derived mode (#688)', () => {
  render(<TaskDefaults id="d" draft={DRAFT} workspaces={['hive', 'site']} onChange={vi.fn()} />);
  const [workspace, auto] = screen.getAllByTestId('task-default-row');
  expect(within(workspace).getByText('obrigatório')).toBeInTheDocument();
  expect(within(workspace).getByLabelText('workspace')).toHaveTextContent('hive');
  expect(within(workspace).getByText('dinâmico · 1 regra define')).toBeInTheDocument();
  expect(within(auto).getByText('executa sozinha')).toBeInTheDocument();
  expect(within(auto).getByLabelText('auto')).toHaveTextContent('sim');
  expect(within(auto).getByText('fixo')).toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.defaults'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.defaultsHint'))).toBeInTheDocument();
});

test('the workspace select offers sem workspace before the Comb\'s workspaces; it and auto não reach onChange as a new draft (#688)', async () => {
  const onChange = vi.fn();
  render(<TaskDefaults id="d" draft={DRAFT} workspaces={['hive', 'site']} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText('workspace')); // a plain click opens Radix reliably here, as in TaskRules' tests
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['sem workspace', 'hive', 'site']);
  fireEvent.click(screen.getByRole('option', { name: 'sem workspace' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, defaults: { workspace: '', auto: true } });
  fireEvent.click(screen.getByLabelText('auto'));
  fireEvent.click(await screen.findByRole('option', { name: 'não' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, defaults: { workspace: 'hive', auto: false } });
});
