import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HiveBoard } from '@/components/HiveBoard';
import { setLanguage } from '@/i18n';
import type { Card, Column, Slot, State } from '../../src/types';

const columns: Column[] = [{ name: 'dev', weight: 1, from: ['Ready'], prompt: '/hive-build {url}' }, { name: 'review', weight: 0, from: ['In review'] }];
const card = (id: string, column: string, extra: Partial<Card> = {}): Card => ({
  task: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` }, column, boardColumn: 'Ready', slug: `hive-${id}-task-${id}`, ...extra,
});
const slot = (id: string, cardId?: string): Slot => ({ id, status: cardId ? 'working' : 'empty', cardId });
const state = (cards: Card[], slots: Slot[]): State => ({ signal: 'green', maxConcurrent: slots.length, slots, columns, cards, usage: [], budget: {}, usageRules: [] });

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('a missing card offers fechar / manter; fechar asks first and posts close, manter posts keep', async () => {
  const user = userEvent.setup();
  render(<HiveBoard state={state([card('1', 'dev', { missing: true })], [slot('s1')])} />);
  expect(screen.getByText('sumiu do board')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'manter' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I1/keep', expect.objectContaining({ method: 'POST' }));
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Fechar esse card?');
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'fechar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I1/close', expect.objectContaining({ method: 'POST' }));
});

test('a running card shows terminal and no iniciar; a blocked card and a column without prompt show no iniciar', () => {
  const running = card('1', 'dev', { slotId: 's1', branch: 'hive-1-task-1' });
  render(<HiveBoard state={state([running, card('2', 'dev', { task: { ...card('2', 'dev').task, blockedBy: ['1'] } }), card('3', 'review')], [slot('s1', 'I1'), slot('s2')])} />);
  expect(screen.getByRole('button', { name: 'terminal' })).toBeInTheDocument();
  expect(screen.getByText('bloqueada por 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'iniciar' })).not.toBeInTheDocument();
  expect(screen.getByText('trabalhando · hive-1-task-1')).toBeInTheDocument();
  expect(screen.queryByText('vazia')).not.toBeInTheDocument(); // both columns have a card
});

test('iniciar posts start straight away with a free slot, and through the raiseMax dialog without one', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<HiveBoard state={state([card('3', 'dev')], [slot('s1')])} />);
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I3/start', expect.objectContaining({ method: 'POST', body: undefined }));
  rerender(<HiveBoard state={state([card('1', 'dev', { slotId: 's1' }), card('3', 'dev')], [slot('s1', 'I1')])} />);
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('Nenhum slot livre. Subir máx. workers de 1 pra 2 e iniciar #3?');
  await user.click(within(dialog).getByRole('button', { name: 'iniciar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I3/start', expect.objectContaining({ method: 'POST', body: JSON.stringify({ raiseMax: true }) }));
});
