import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TasksField } from '@/components/benchmark/arms/TasksField';
import { setLanguage } from '@/i18n';

beforeEach(() => setLanguage('pt'));

test('the table collapses after 4 rows, a chevron opens a body, + tarefa adds T<n+1> (#536)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const tasks = Array.from({ length: 6 }, (_, i) => ({ key: `T${i + 1}`, title: `t${i + 1}`, body: `b${i + 1}`, blockedBy: [] }));
  render(<TasksField value={tasks} onChange={onChange} isReadOnly={false} />);
  expect(screen.getAllByRole('textbox', { name: 'chave' })).toHaveLength(4);
  await user.click(screen.getByRole('button', { name: 'mais 2 tarefas' }));
  expect(screen.getAllByRole('textbox', { name: 'chave' })).toHaveLength(6);
  await user.click(screen.getByRole('button', { name: 'corpo de T2' }));
  expect(screen.getByRole('textbox', { name: 'corpo de T2' })).toHaveValue('b2');
  await user.click(screen.getByRole('button', { name: '+ tarefa' }));
  expect(onChange).toHaveBeenLastCalledWith([...tasks, { key: 'T7', title: '', body: '', blockedBy: [] }]);
});

test("an arm on the base's tasks reads the summary; ver e editar opens the table, esconder closes it (#536)", async () => {
  const user = userEvent.setup();
  render(<TasksField value={[{ key: 'T1', title: 'a', body: '', blockedBy: [] }]} onChange={vi.fn()} isReadOnly={false} summary="1 tarefa · 0 bloqueios · t·91d4" />);
  expect(screen.getByText('1 tarefa · 0 bloqueios · t·91d4')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'chave' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'ver e editar' }));
  expect(screen.getByRole('textbox', { name: 'chave' })).toHaveValue('T1');
  expect(screen.getByText('editar sobrepõe as tarefas da base')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'esconder' }));
  expect(screen.queryByRole('textbox', { name: 'chave' })).not.toBeInTheDocument();
});

test('editing a field and removing a row report the new list; blocked by splits on spaces (#536)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const tasks = [{ key: 'T1', title: 'a', body: '', blockedBy: [] }, { key: 'T2', title: 'b', body: '', blockedBy: ['T1'] }];
  render(<TasksField value={tasks} onChange={onChange} isReadOnly={false} />);
  await user.type(screen.getAllByRole('textbox', { name: 'título' })[0], '!');
  expect(onChange).toHaveBeenLastCalledWith([{ ...tasks[0], title: 'a!' }, tasks[1]]);
  await user.type(screen.getAllByRole('textbox', { name: 'bloqueada por' })[1], ' ');
  expect(onChange).toHaveBeenLastCalledWith([tasks[0], { ...tasks[1], blockedBy: ['T1', ''] }]); // the blank is dropped on save
  await user.click(screen.getByRole('button', { name: 'remover T1' }));
  expect(onChange).toHaveBeenLastCalledWith([tasks[1]]);
});

test('read only: chevrons open, no + tarefa, no remove, inputs read only (#536)', async () => {
  const user = userEvent.setup();
  render(<TasksField value={[{ key: 'T1', title: 'a', body: 'corpo um', blockedBy: [] }]} onChange={vi.fn()} isReadOnly />);
  expect(screen.getByRole('textbox', { name: 'chave' })).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: '+ tarefa' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'remover T1' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'corpo de T1' }));
  expect(screen.getByRole('textbox', { name: 'corpo de T1' })).toHaveValue('corpo um');
});
