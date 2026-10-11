import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrTaskPopover } from '@/components/PrTaskPopover';
import { setLanguage } from '@/i18n';
import { CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';
import { jsonResponse } from '../fakes';
import { PR, prData, STATE } from './pr-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ id: 'HIVE-1', itemId: 'local:1' }, 201));
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('criar tarefa… confirms first, then creates the hive task linked to the PR with its title, the first stage and auto off, and closes (#68)', async () => {
  const user = userEvent.setup();
  render(<PrTaskPopover pr={prData()} state={STATE} />);
  await user.click(screen.getByRole('button', { name: 'criar tarefa…' }));
  expect(screen.getByText('criar tarefa no fluxo')).toBeInTheDocument();
  expect(screen.getByText('#7 fica ligado a uma tarefa nova na source hive, sem sync: mudanças no GitHub não chegam à tarefa.')).toHaveClass('text-muted-foreground');
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(screen.queryByText('criar tarefa no fluxo')).toBeNull());
  const [path, init] = fetchMock.mock.calls[0];
  expect([String(path), JSON.parse(String(init?.body))]).toEqual(['/tasks', { title: 'The PR', stage: 'dev', auto: false, pr: PR, source: 'hive' }]);
});

test('a refusal is a toast and the popover stays; cancelar closes it (#68)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'unknown stage' }, 400));
  render(<PrTaskPopover pr={prData()} state={STATE} />);
  await user.click(screen.getByRole('button', { name: 'criar tarefa…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('unknown stage'));
  expect(screen.getByText('criar tarefa no fluxo')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  expect(screen.queryByText('criar tarefa no fluxo')).toBeNull();
});

test('with the hive source off, criar tarefa… is not offered (#68, #846)', () => {
  render(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, hiveSource: false }}><PrTaskPopover pr={prData()} state={STATE} /></CreateTargetsContext.Provider>);
  expect(screen.queryByRole('button', { name: 'criar tarefa…' })).toBeNull();
});
