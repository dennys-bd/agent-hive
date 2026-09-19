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
const state = (cards: Card[], slots: Slot[], cols: Column[] = columns): State => ({ signal: 'green', maxConcurrent: slots.length, slots, columns: cols, cards, usage: [], budget: {}, usageRules: [] });
const capped: Column[] = [{ name: 'spec', weight: 5, visible: 2, from: ['Backlog'], prompt: '/hive-spec {url}' }];
const titles = () => screen.getAllByText(/^#\d Task/).map((el) => el.textContent);

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

test('a card whose spawn failed shows the error (full message as title) and still offers iniciar, which posts start', async () => {
  const user = userEvent.setup();
  render(<HiveBoard state={state([card('1', 'dev', { error: 'tmux: spawn tmux ENOENT' })], [slot('s1')])} />);
  const badge = screen.getByText('tmux: spawn tmux ENOENT').closest('[data-slot="badge"]');
  expect(badge).toHaveAttribute('title', 'tmux: spawn tmux ENOENT');
  expect(badge).toHaveAttribute('data-variant', 'destructive');
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I1/start', expect.objectContaining({ method: 'POST' }));
});

test('a column with visible shows the first N stopped cards, the header counts them all, and the toggle reveals and hides the rest', async () => {
  setLanguage('en'); // the spec's strings; the other tests stay in pt
  const user = userEvent.setup();
  const cards = ['1', '2', '3', '4', '5'].map((id) => card(id, 'spec'));
  render(<HiveBoard state={state(cards, [slot('s1')], capped)} />);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('spec · 5 cards · weight 5');
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2']);
  await user.click(screen.getByRole('button', { name: '+3 more' }));
  expect(titles()).toHaveLength(5);
  expect(screen.queryByRole('button', { name: '+3 more' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'show less' }));
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2']);
  expect(screen.queryByRole('button', { name: 'show less' })).not.toBeInTheDocument();
});

test('running cards always show and count against visible; without visible (or 0) every card shows and there is no toggle', () => {
  const running = (id: string) => card(id, 'spec', { slotId: `s${id}` });
  const slots = [slot('s1', 'I1'), slot('s2', 'I2'), slot('s3', 'I3')];
  const cards = [card('4', 'spec'), running('1'), running('2'), card('5', 'spec'), running('3')]; // board order, running cards interleaved
  const { rerender } = render(<HiveBoard state={state(cards, slots, capped)} />);
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']); // 3 running > visible 2: no room for a stopped card
  expect(screen.getAllByRole('button', { name: 'terminal' })).toHaveLength(3);
  expect(screen.getByRole('button', { name: '+2 mais' })).toBeInTheDocument();
  rerender(<HiveBoard state={state(cards, slots, [{ ...capped[0], visible: 0 }])} />);
  expect(titles()).toHaveLength(5);
  expect(screen.queryByRole('button', { name: /mais|menos/ })).not.toBeInTheDocument();
  rerender(<HiveBoard state={state(cards, slots, [{ name: 'spec', weight: 5, from: ['Backlog'] }])} />);
  expect(titles()).toHaveLength(5);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('spec · 5 cards · peso 5');
});
