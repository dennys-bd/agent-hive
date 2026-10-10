import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MetaGrid } from '@/components/DetailSections';
import { PrOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task } from '../../src/types';

const PR = 'https://github.com/acme/app/pull/7';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
// The task's PR, in its record (#629)
const state = { workers: [], activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions: [], prs: [{ url: PR, state: 'open' as const }] }] };
beforeEach(() => setLanguage('pt'));

test('a PR link opens the PR\'s page through the dock\'s opener, and GitHub outside a Dashboard (#592, #758)', () => {
  const openPr = vi.fn();
  const { rerender } = render(<PrOpenerContext.Provider value={openPr}><MetaGrid task={task} state={state} isActivity /></PrOpenerContext.Provider>);
  const link = screen.getByRole('link', { name: '#7' });
  expect(link).toHaveAttribute('href', PR);
  expect(fireEvent.click(link)).toBe(false); // the default prevented: no browser
  expect(openPr).toHaveBeenCalledWith(PR);
  rerender(<MetaGrid task={task} state={state} isActivity />);
  expect(fireEvent.click(screen.getByRole('link', { name: '#7' }))).toBe(true);
});

test('the PRs row groups the task\'s PRs: the stack\'s header, k/n, the state and the base on an open line; another repository after a separator, its name ending the line; each number opens its PR (#698)', () => {
  const APP = 'https://github.com/acme/app/pull/';
  const SITE = 'https://github.com/acme/site/pull/3';
  const prs = [
    { url: `${APP}10`, state: 'merged' as const, slice: { k: 1, type: 'stacked' as const } },
    { url: SITE, state: 'open' as const },
    { url: `${APP}11`, state: 'open' as const, slice: { k: 2, type: 'stacked' as const } },
  ];
  const own: Task = { ...task, item: { ...task.item, facets: { assignees: [], labels: [], repository: 'acme/app', fields: {} } } };
  const openPr = vi.fn();
  const grouped = { ...state, activityRecords: [{ ...state.activityRecords[0], prs }] };
  render(<PrOpenerContext.Provider value={openPr}><MetaGrid task={own} state={grouped} isActivity /></PrOpenerContext.Provider>);
  const row = screen.getByText('PRs', { selector: 'dt' }).nextElementSibling as HTMLElement;
  expect(row).toHaveTextContent('pilha · 1 de 2 mergeados1/2 #10 · mergeado2/2 #11 · aberto · base #10#3 · aberto · site');
  expect(within(row).getAllByRole('separator')).toHaveLength(1);
  fireEvent.click(within(row).getByRole('link', { name: '#3' }));
  expect(openPr).toHaveBeenCalledWith(SITE);
});
