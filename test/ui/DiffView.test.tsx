import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DiffView } from '@/components/DiffView';
import { setLanguage } from '@/i18n';
import { activityOf, callsTo, task, fakeHive, type FakeHive, LABEL, renderPane } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const pane = (): HTMLElement => screen.getByRole('region', { name: LABEL });
const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'barra do diff' });
const list = (): HTMLElement => screen.getByRole('navigation', { name: 'arquivos do diff' });
const rows = (): string[] => within(list()).getAllByRole('button').map((b) => b.textContent ?? '');

test('the pane draws the bar\'s totals, a 280px list (mark, dir muted, name, counts) with the first file open, and each file\'s section (#591)', async () => {
  renderPane();
  expect(within(pane()).getByText('carregando…')).toBeInTheDocument();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  expect(callsTo(hive, 'GET', '/activities/a-I1/diff?scope=worktree')).toHaveLength(1);
  expect(bar()).toHaveTextContent('3 arquivos · +1 −1');
  expect(list()).toHaveClass('w-[280px]', 'border-r');
  expect(rows()).toEqual(['Msrc/a.ts+1 −1', 'Mb.ts+0 −0', 'Aimg/logo.png']);
  expect(within(list()).getByText('src/')).toHaveClass('text-muted-foreground');
  expect(within(list()).getByText('A')).toHaveClass('text-working');
  expect(within(list()).getAllByRole('button')[0]).toHaveAttribute('aria-current', 'true');
  expect(within(pane()).getByText('a-old.ts → b.ts')).toBeInTheDocument();
});

test('the filter keeps the paths holding its text, any case; a row click opens that file (#591)', async () => {
  const user = userEvent.setup();
  renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  await user.type(within(list()).getByRole('textbox', { name: 'filtrar arquivos' }), 'LOGO');
  expect(rows()).toEqual(['Aimg/logo.png']);
  await user.click(within(list()).getByRole('button'));
  expect(within(list()).getByRole('button')).toHaveAttribute('aria-current', 'true');
});

test('lado a lado draws six cells a row, is remembered in hive.diffLayout, and a new pane opens on it (#591)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  await user.click(within(bar()).getByRole('radio', { name: 'lado a lado' }));
  const section = within(pane()).getByRole('region', { name: 'src/a.ts' });
  expect(within(section).getAllByRole('row')[2].querySelectorAll('td')).toHaveLength(6);
  expect(localStorage.getItem('hive.diffLayout')).toBe('split');
  unmount();
  renderPane();
  expect(await within(bar()).findByRole('radio', { name: 'lado a lado' })).toHaveAttribute('data-state', 'on');
});

test('the scope picker lists worktree, etapa, último commit and ponto de restauração, disables one the task cannot diff with its reason, and hands a pick to onScope (#591)', async () => {
  const user = userEvent.setup();
  const { onScope } = renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  const trigger = within(bar()).getByRole('button', { name: 'escopo do diff' });
  expect(trigger).toHaveTextContent('worktree');
  trigger.focus();
  await user.keyboard('{Enter}');
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['worktree', 'etapa', 'último commit', 'ponto de restauração']);
  expect(items[3]).toHaveAttribute('data-disabled');
  expect(items[3]).toHaveAttribute('title', 'a tarefa ainda não tem pontos de restauração');
  expect(items[1]).toHaveAttribute('data-disabled');
  expect(items[1]).toHaveAttribute('title', 'a etapa atual não tem início registrado');
  await user.click(items[2]);
  expect(onScope).toHaveBeenCalledWith('commit', undefined);
});

test('the pane says nenhuma mudança for an empty diff and shows the route\'s error otherwise (#270)', async () => {
  hive.diff = { ...hive.diff, files: [] };
  const { unmount } = renderPane();
  expect(await within(pane()).findByText('nenhuma mudança')).toBeInTheDocument();
  unmount();
  hive.diffError = 'diff grande demais para o visualizador';
  renderPane();
  expect(await within(pane()).findByRole('alert')).toHaveTextContent('diff grande demais para o visualizador');
});

test('atualizar fetches again, as does each show of the tab, never while hidden (#270)', async () => {
  const user = userEvent.setup();
  const { rerender, tab, onScope } = renderPane();
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  await user.click(within(bar()).getByRole('button', { name: 'atualizar' }));
  const diffs = (): number => hive.calls.filter((c) => c.url.startsWith('/activities/a-I1/diff')).length;
  await waitFor(() => expect(diffs()).toBe(2));
  rerender(<DiffView tab={tab} label={LABEL} active={false} activity={activityOf({ task })} onScope={onScope} />);
  expect(diffs()).toBe(2);
  rerender(<DiffView tab={tab} label={LABEL} active activity={activityOf({ task })} onScope={onScope} />);
  await waitFor(() => expect(diffs()).toBe(3));
});
