import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SearchDialog } from '@/components/SearchDialog';
import { setLanguage } from '@/i18n';
import { activitiesOf } from '@/lib/activities';
import { onPanelKey } from '@/lib/dock-layout';
import type { OperationContext } from '@/lib/operations';
import type { Scope } from '@/lib/search';
import type { Task, State } from '../../src/types';
import { ctxOf, recordFor, stateOf, task } from './search-fixtures';
import { activityIdOf } from '../fixtures/work';

const DAEMON = task('466', 'The daemon binds a free port', { worktree: '/w/466', branch: 'hive/466-daemon' });
const SECRET: Task = { ...task('467', ''), item: { itemId: 'I467', id: '467', title: 'Every request to the daemon carries a secret', body: '', url: '', blockedBy: ['466'] } };
const RESTART = task('503', 'The daemon restarts after a crash');
const STATE = stateOf([DAEMON, SECRET, RESTART]);

function renderSearch(scope: Scope = 'all', ctx: OperationContext = ctxOf(STATE), state: State = STATE) {
  const onClose = vi.fn();
  render(<SearchDialog scope={scope} ctx={ctx} activities={activitiesOf(state)} onClose={onClose} />);
  return { onClose, nav: ctx.nav };
}
const field = (): HTMLElement => screen.getByRole('combobox', { name: 'busca' });
const scopeShown = (): HTMLElement => screen.getByRole('button', { pressed: true });

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

test('opens on its scope with the field focused; Tab and Shift+Tab cycle the scopes; a # typed first switches to tarefas and leaves the field (#584)', async () => {
  const user = userEvent.setup();
  renderSearch('commands');
  expect(scopeShown()).toHaveTextContent('comandos');
  expect(field()).toHaveFocus();
  expect(field()).toHaveAttribute('placeholder', 'buscar atividades, tarefas e comandos');
  await user.keyboard('{Tab}');
  expect(scopeShown()).toHaveTextContent('tudo');
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(scopeShown()).toHaveTextContent('comandos');
  await user.keyboard('#');
  expect(scopeShown()).toHaveTextContent('tarefas');
  expect(field()).toHaveValue('');
});

test('tudo groups atividades, tarefas and comandos; a task with an activity only under atividades; the match drawn; the footer counts and names ⌘↵ (#584)', async () => {
  const user = userEvent.setup();
  renderSearch();
  await user.keyboard('daemon');
  const atividades = screen.getByRole('group', { name: 'atividades' });
  expect(within(atividades).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('#466 The daemon binds a free port')]);
  expect(within(screen.getByRole('group', { name: 'tarefas' })).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('#467'), expect.stringContaining('#503')]);
  expect(within(atividades).getByText('daemon', { selector: 'b' })).toHaveClass('font-medium');
  expect(screen.getByText('bloqueada por 466')).toBeInTheDocument();
  expect(screen.getByText('3 resultados')).toBeInTheDocument();
  expect(screen.getByText('ver no fluxo')).toBeInTheDocument();
});

test('↵ opens an activity in the center and ⌘↵ shows it in the flow; on a task ↵ opens the Start dialog on it and ⌘↵ its details (#584)', async () => {
  const user = userEvent.setup();
  const { onClose, nav } = renderSearch();
  await user.keyboard('466{Enter}');
  expect(nav.openActivity).toHaveBeenCalledWith('I466');
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(nav.showFlow).toHaveBeenCalledWith('I466');
  await user.clear(field());
  await user.keyboard('503{Enter}');
  expect(nav.startTask).toHaveBeenCalledWith({ itemId: 'I503' });
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(nav.showFlow).toHaveBeenLastCalledWith('I503');
  expect(onClose).toHaveBeenCalledTimes(4);
});

test('Esc clears the field when it has text, and closes only once it is empty (#584)', async () => {
  const user = userEvent.setup();
  const { onClose } = renderSearch();
  await user.keyboard('daemon{Escape}');
  expect(field()).toHaveValue('');
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('no result says so; in tarefas it offers + criar tarefa, which opens the Start dialog creating that title (#584)', async () => {
  const user = userEvent.setup();
  const { nav } = renderSearch();
  await user.keyboard('zzqq');
  expect(screen.getByText('nada encontrado para "zzqq"')).toBeInTheDocument();
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  await user.keyboard('{Tab}{Tab}'); // tudo → atividades → tarefas
  await user.click(screen.getByRole('option', { name: '+ criar tarefa "zzqq"' }));
  expect(nav.startTask).toHaveBeenCalledWith({ title: 'zzqq' });
});

test('comandos list every available operation with its shortcut; ↵ closes the search and runs it (#584)', async () => {
  const user = userEvent.setup();
  const toggle = vi.fn();
  const stop = onPanelKey(toggle);
  const { onClose } = renderSearch('commands');
  expect(screen.getByRole('option', { name: /abrir ou fechar o painel da esquerda/ })).toHaveTextContent('Ctrl+Shift+B');
  await user.keyboard('esquerda{Enter}');
  stop();
  expect(onClose).toHaveBeenCalled();
  expect(toggle).toHaveBeenCalledWith('left');
});

test('the empty field shows recentes and precisam de você (#584)', () => {
  const now = new Date(Date.now() - 30_000).toISOString();
  const live = task('1', 'Live', { worktree: '/w/1' });
  const activityRecords = [recordFor('I1', { sessions: [{ id: 's-1', startedAt: now, stages: ['dev'], agent: 'claude' as const, lastUsedAt: now }] })]; // #629: the session is the record's
  const state = stateOf([live], { workers: [{ id: 'a', activityId: activityIdOf('I1'), status: 'waiting', runId: 'W1', waitingSince: now }], activityRecords });
  renderSearch('all', ctxOf(state), state);
  expect(within(screen.getByRole('group', { name: 'recentes' })).getByRole('option')).toHaveTextContent(/#1 Live.*claude · agora.*esperando você/);
  expect(within(screen.getByRole('group', { name: 'precisam de você' })).getByRole('option')).toHaveTextContent('#1 Live');
});

test('an operation with › opens its page, named beside the field; Backspace on the empty field goes back; a pick runs (#584)', async () => {
  const user = userEvent.setup();
  renderSearch('commands');
  await user.keyboard('sinal{Enter}');
  const page = screen.getByRole('group', { name: 'sinal' });
  expect(within(page).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('green'), expect.stringContaining('yellow'), expect.stringContaining('red')]);
  expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument(); // a page has no scope
  await user.keyboard('{Backspace}');
  expect(screen.queryByRole('group', { name: 'sinal' })).not.toBeInTheDocument();
  expect(scopeShown()).toHaveTextContent('comandos');
  await user.keyboard('sinal{Enter}yel{Enter}');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/signal', expect.objectContaining({ body: JSON.stringify({ signal: 'yellow' }) })));
});

test('→ on an activity row opens its operations page; ← on the empty field goes back (#584)', async () => {
  const user = userEvent.setup();
  renderSearch();
  await user.keyboard('466{ArrowRight}');
  const page = screen.getByRole('group', { name: '#466 →' });
  expect(within(page).getAllByRole('option').map((o) => o.textContent)).toEqual([
    expect.stringContaining('começar sozinho'), expect.stringContaining('nova sessão'), expect.stringContaining('diff'), expect.stringContaining('mostrar PR'), expect.stringContaining('excluir atividade…'),
  ]);
  await user.keyboard('{ArrowLeft}');
  expect(screen.queryByRole('group', { name: '#466 →' })).not.toBeInTheDocument();
  expect(scopeShown()).toHaveTextContent('tudo');
});

test('closing gives the focus back to what had it, unless a picked operation moved it elsewhere (#584)', async () => {
  const user = userEvent.setup();
  function Host() {
    const [isOpen, setIsOpen] = useState(true);
    return (
      <>
        <button type="button">before</button>
        <button type="button">elsewhere</button>
        {isOpen && <SearchDialog scope="commands" ctx={ctxOf(STATE)} activities={activitiesOf(STATE)} onClose={() => setIsOpen(false)} />}
      </>
    );
  }
  const before = document.createElement('button');
  document.body.append(before);
  before.focus();
  const view = render(<Host />);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(before).toHaveFocus());
  view.unmount();
  // as a terminal that focuses itself in an effect once the search has closed; by text, as the open dialog hides the page from the role queries
  const stop = onPanelKey(() => void setTimeout(() => screen.getByText('elsewhere').focus(), 0));
  render(<Host />);
  await user.keyboard('direita{Enter}');
  stop();
  await waitFor(() => expect(screen.getByText('elsewhere')).toHaveFocus());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText('elsewhere')).toHaveFocus();
  before.remove();
});

test('a stopped task\'s auto badge is struck through in tarefas (#735)', async () => {
  const user = userEvent.setup();
  const state = stateOf([task('503', 'The daemon restarts after a crash', { stopped: true }), task('504', 'The daemon logs its port')]);
  renderSearch('tasks', ctxOf(state), state);
  await user.keyboard('daemon');
  const badge = (title: string): HTMLElement => within(screen.getByRole('option', { name: new RegExp(title) })).getByText('auto');
  expect(badge('restarts')).toHaveClass('opacity-50', 'line-through');
  expect(badge('logs')).not.toHaveClass('line-through');
});
