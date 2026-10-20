import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskPicker } from '@/components/TaskPicker';
import { setLanguage } from '@/i18n';
import type { Destination } from '@/lib/create-targets';

const HIVE_AND_ROADMAP: Destination[] = [{ name: 'hive' }, { name: 'roadmap', type: 'github' }];
const FIELD = 'buscar ou criar tarefa…';
const picker = (destinations?: Destination[], onCreate = vi.fn()) =>
  render(<TaskPicker id="task" tasks={[]} workspaces={['hive']} destinations={destinations} onPick={vi.fn()} onCreate={onCreate} />);

beforeEach(() => setLanguage('pt'));

test('closed with nothing picked, the field reads as a search box: the ⌕ and buscar ou criar tarefa…, no chevron (#893)', () => {
  picker();
  const field = screen.getByRole('button', { name: FIELD });
  expect(field.querySelectorAll('svg')).toHaveLength(1); // the ⌕ alone
});

test('a typed term shows one create row on the default destination\'s chip; criar em lists each destination with its second line, a pick sets the chip and creates nothing, and the row then creates there (#893)', async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn();
  picker(HIVE_AND_ROADMAP, onCreate);
  await user.click(screen.getByRole('button', { name: FIELD }));
  await user.keyboard('landing');
  expect(screen.getAllByRole('option', { name: /criar tarefa/ })).toHaveLength(1);
  const row = screen.getByRole('option', { name: /criar tarefa "landing"/ });
  await user.click(within(row).getByRole('button', { name: 'em hive' }));
  expect(onCreate).not.toHaveBeenCalled();
  expect(screen.getByText('criar em')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^hive.*só no hive, sem issue externa$/ })).toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: /^roadmap.*github project$/ }));
  expect(onCreate).not.toHaveBeenCalled();
  expect(screen.queryByText('criar em')).not.toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: /criar tarefa "landing".*em roadmap/ }));
  expect(onCreate).toHaveBeenCalledWith('landing', 'roadmap');
});

test('the keys reach criar em: Enter on the chip opens it on its destination, Escape closes the menu alone, the arrows and Enter pick, and Enter on the row creates there (#893)', async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn();
  picker(HIVE_AND_ROADMAP, onCreate);
  await user.click(screen.getByRole('button', { name: FIELD }));
  await user.keyboard('landing');
  await user.tab();
  expect(screen.getByRole('button', { name: 'em hive' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('combobox', { name: 'tarefas' })).toHaveFocus();
  expect(screen.getByRole('option', { name: /^hive/ })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Escape}');
  expect(screen.queryByText('criar em')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'tarefas' })).toBeInTheDocument(); // the list stays open
  await user.tab();
  await user.keyboard('{Enter}{ArrowDown}{Enter}');
  expect(onCreate).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(onCreate).toHaveBeenCalledWith('landing', 'roadmap');
});

test('with hive the only destination, the chip shows with no menu (#893)', async () => {
  const user = userEvent.setup();
  picker();
  await user.click(screen.getByRole('button', { name: FIELD }));
  await user.keyboard('landing');
  const row = screen.getByRole('option', { name: /criar tarefa "landing"/ });
  expect(row).toHaveTextContent(/em hive$/);
  expect(within(row).queryByRole('button')).not.toBeInTheDocument();
});
