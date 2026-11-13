import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CommandSemaphoresCard } from '@/components/settings/CommandSemaphoresCard';
import { setLanguage, t } from '@/i18n';
import { commandDraft } from '@/lib/settings-commands';
import { emptyWorkspace, type SettingsDraft } from '@/lib/settings-form';
import { semaphoreDrafts } from '@/lib/settings-semaphores';
import type { Command, SemaphoreState } from '../../src/types';

const API = { ...emptyWorkspace(), name: 'core-api', path: '/core-api' };
const HIVE = { ...emptyWorkspace(), name: 'agent-hive', path: '/agent-hive' };
const SEMAPHORES = semaphoreDrafts([{ name: 'memory', limit: 1, reservation: '2m' }, { name: 'banco', limit: 1, reservation: '5m' }]);
const TESTES: Command = { name: 'testes', impls: [{ workspace: 'core-api', command: 'pnpm test', semaphore: 'memory' }, { workspace: null, command: 'make test', semaphore: 'memory' }], menu: true, env: {} };
const LINT: Command = { name: 'lint', impls: [{ workspace: 'agent-hive', command: 'pnpm lint', semaphore: 'memory' }], menu: true, env: {} };
const COMMANDS = [TESTES, LINT].map((c) => commandDraft(c, [API, HIVE], SEMAPHORES));

type Draft = Pick<SettingsDraft, 'commandSemaphores' | 'commands' | 'workspaces'>;
const FULL: Draft = { commandSemaphores: SEMAPHORES, commands: COMMANDS, workspaces: [API, HIVE] };

// Holds the draft as Settings does, so an edit redraws the card
function Harness({ initial, live, onDraft }: { initial: Draft; live?: Record<string, SemaphoreState>; onDraft?(draft: Draft): void }) {
  const [draft, setDraft] = useState(initial);
  const change = (patch: Partial<SettingsDraft>): void => { const next = { ...draft, ...patch }; setDraft(next); onDraft?.(next); };
  return <CommandSemaphoresCard semaphores={draft.commandSemaphores} commands={draft.commands} workspaces={draft.workspaces} live={live} onChange={change} onOpenWorkspaces={vi.fn()} />;
}

beforeEach(() => setLanguage('pt'));

test('with no semaphore the card shows only its foot: + revezamento and its hint, no column header (#803 decision 1)', () => {
  render(<Harness initial={{ ...FULL, commandSemaphores: [] }} />);
  expect(screen.getByRole('heading', { level: 2, name: 'revezamentos' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '+ revezamento' })).toBeInTheDocument();
  expect(screen.getByText('uma linha sem revezamento executa na hora')).toBeInTheDocument();
  expect(screen.queryByText(t('settings.semaphores.limit'))).not.toBeInTheDocument();
  expect(screen.queryAllByTestId('semaphore-row')).toHaveLength(0);
});

test('each row reads its lines in comandos and its State in agora, which follows a new state with no reload (#803 decisions 7, 8)', () => {
  const { rerender } = render(<Harness initial={FULL} live={{ memory: { runs: ['A'], line: [] } }} />);
  expect(screen.getByText(t('settings.semaphores.limit'))).toBeInTheDocument();
  const [memory, banco] = screen.getAllByTestId('semaphore-row');
  expect(within(memory).getByText('testes em core-api e os demais workspaces · lint em agent-hive')).toBeInTheDocument();
  expect(within(banco).getByText('—')).toBeInTheDocument();
  expect(within(memory).getByText('1 executando')).toBeInTheDocument();
  expect(within(banco).getByText('livre')).toBeInTheDocument();
  rerender(<Harness initial={FULL} live={{ memory: { runs: ['A'], line: [{ ptyId: 'B', place: 1 }, { ptyId: 'C', place: 2 }] } }} />);
  expect(within(memory).getByText('2 na vez')).toBeInTheDocument();
  expect(within(memory).getByText('1 executando')).toHaveClass('text-foreground');
});

test('+ revezamento appends a row with limit 1 and reservation 1m and focuses its name; a bad field is marked aria-invalid as it is typed (#803 decisions 5, 6)', async () => {
  const user = userEvent.setup();
  const onDraft = vi.fn();
  render(<Harness initial={{ ...FULL, commandSemaphores: [] }} onDraft={onDraft} />);
  await user.click(screen.getByRole('button', { name: '+ revezamento' }));
  const [row] = screen.getAllByTestId('semaphore-row');
  const name = within(row).getByLabelText('nome do revezamento');
  expect(name).toHaveFocus();
  expect(within(row).getByLabelText('novo revezamento: ao mesmo tempo')).toHaveValue(1);
  expect(within(row).getByLabelText('novo revezamento: reserva da vez')).toHaveValue('1m');
  expect(name).toHaveAttribute('aria-invalid', 'true');
  await user.keyboard('ports');
  expect(name).not.toHaveAttribute('aria-invalid');
  const limit = within(row).getByLabelText('ports: ao mesmo tempo');
  await user.clear(limit);
  await user.type(limit, '0');
  expect(limit).toHaveAttribute('aria-invalid', 'true');
  const reservation = within(row).getByLabelText('ports: reserva da vez');
  await user.clear(reservation);
  await user.type(reservation, 'soon');
  expect(reservation).toHaveAttribute('aria-invalid', 'true');
  expect((onDraft.mock.lastCall![0] as Draft).commandSemaphores.map(({ id: _id, ...s }) => s)).toEqual([{ name: 'ports', limit: '0', reservation: 'soon' }]);
});

test('a rename keeps the row\'s lines; × removes the row at once, with no confirmation, and clears it from every line pointing at it (#803 decisions 3, 4)', async () => {
  const user = userEvent.setup();
  const onDraft = vi.fn();
  render(<Harness initial={FULL} onDraft={onDraft} />);
  const name = screen.getByDisplayValue('memory');
  await user.clear(name);
  await user.type(name, 'heavy');
  const [heavy] = screen.getAllByTestId('semaphore-row');
  expect(within(heavy).getByText('testes em core-api e os demais workspaces · lint em agent-hive')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'remover heavy' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getAllByTestId('semaphore-row')).toHaveLength(1);
  const last = onDraft.mock.lastCall![0] as Draft;
  expect(last.commandSemaphores.map((s) => s.name)).toEqual(['banco']);
  expect(last.commands.flatMap((c) => c.impls).some((i) => 'semaphore' in i)).toBe(false);
});

test('the foot links to workspaces › comandos; every string reads in English too (#803)', async () => {
  const user = userEvent.setup();
  const onOpenWorkspaces = vi.fn();
  setLanguage('en');
  render(<CommandSemaphoresCard semaphores={SEMAPHORES} commands={COMMANDS} workspaces={[API, HIVE]} onChange={vi.fn()} onOpenWorkspaces={onOpenWorkspaces} />);
  expect(screen.getByRole('heading', { level: 2, name: 'Command Semaphores' })).toBeInTheDocument();
  expect(screen.getByLabelText('memory: at the same time')).toHaveValue(1);
  expect(screen.getByRole('button', { name: 'remove banco' })).toBeInTheDocument();
  expect(screen.getAllByText('free')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'workspaces › commands' }));
  expect(onOpenWorkspaces).toHaveBeenCalledTimes(1);
});
