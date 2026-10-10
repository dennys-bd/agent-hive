import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { codeLine } from '@/components/PrTimeline';
import { setLanguage } from '@/i18n';
import { FILE, fakePrHive, type FakePrHive, prCalls, prData, renderPage, ROUTE } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());

test('the timeline lists general comments, threads and reviews oldest first, an empty comment review left out; a thread shows its path, line and code (#758)', async () => {
  hive.pr = prData({
    reviews: [
      { id: 'R1', author: 'caio', at: '2026-09-30T12:00:00.000Z', kind: 'changes', text: 'not yet' },
      { id: 'R2', author: 'caio', at: '2026-09-30T13:00:00.000Z', kind: 'commented', text: '' },
    ],
    comments: [{ id: 'IC1', author: 'dani', at: '2026-09-30T09:00:00.000Z', text: 'first!' }],
  }); // the harness's thread speaks first at 10:00
  renderPage();
  const timeline = within(await screen.findByRole('region', { name: 'conversa' }));
  const items = timeline.getAllByRole('article');
  expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining('first!'), expect.stringContaining('src/a.ts'), expect.stringContaining('not yet')]);
  expect(within(items[1]).getByText('linha 2')).toBeInTheDocument();
  expect(within(items[1]).getByText('2', { selector: 'pre' })).toBeInTheDocument();
  expect(within(items[1]).getByRole('group', { name: 'conversa' })).toBeInTheDocument();
  expect(within(items[2]).getByText('pediu mudanças')).toHaveClass('text-waiting');
  expect(screen.getByRole('tab', { name: 'conversa 3' })).toBeInTheDocument();
});

test('codeLine reads the anchored line off the diff, on either side; none when the diff lacks it (#758)', () => {
  expect(codeLine([FILE], { path: 'src/a.ts', side: 'new', start: 2, end: 2 })).toBe('2');
  expect(codeLine([FILE], { path: 'src/a.ts', side: 'old', start: 2, end: 2 })).toBe('two');
  expect(codeLine([FILE], { path: 'gone.ts', side: 'new', start: 1, end: 1 })).toBeUndefined();
});

test('open in diff switches to files with the thread\'s file shown (#758)', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'abrir na diff' }));
  expect(screen.getByRole('tab', { name: 'arquivos 1' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
});

test('the comment box posts a general comment and the page reads the PR again; a merged PR has none (#758)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage();
  await user.type(await screen.findByRole('textbox', { name: 'comentar no PR…' }), 'thanks');
  await user.click(screen.getByRole('button', { name: /^comentar/ }));
  await waitFor(() => expect(prCalls(hive, 'POST', `${ROUTE}/comments`)[0]?.body).toEqual({ body: 'thanks' }));
  await waitFor(() => expect(hive.calls.filter((c) => c.method === 'GET' && c.url === ROUTE)).toHaveLength(2));
  unmount();
  hive.pr = prData({ state: 'merged' });
  renderPage();
  await screen.findByText('mergeado: só leitura');
  expect(screen.queryByRole('textbox', { name: 'comentar no PR…' })).toBeNull();
});
