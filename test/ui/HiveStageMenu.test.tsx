import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HiveStageMenu } from '@/components/HiveStageMenu';
import { setLanguage } from '@/i18n';
import type { Flow, Stage, Task } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('spec'), stage('dev')], transitions: [] }, { name: 'ship', stages: [stage('review')], transitions: [] }];
const task = (at?: string): Task => ({
  item: { itemId: 'local:7', id: 'HIVE-7', title: 'T', body: '', url: '' }, ...(at === undefined ? {} : { stage: at }), boardColumn: '', auto: false, created: true,
});
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

// Radix opens a menu on Enter on the focused trigger under jsdom, as project-harness's openMenu does
async function open(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  screen.getByRole('button', { name }).focus();
  await user.keyboard('{Enter}');
}
const posted = (): [string, unknown][] => fetchMock.mock.calls.map(([input, init]) => [String(input), init?.body]);

test('the menu lists every stage under its flow\'s name in the config\'s order, then sem fluxo; the current entry is checked; the trigger is a field cell (#583)', async () => {
  const user = userEvent.setup();
  render(<HiveStageMenu task={task('dev')} flows={FLOWS} />);
  expect(screen.getByRole('button', { name: 'dev' })).toHaveAttribute('data-slot', 'field-cell');
  await open(user, 'dev');
  expect(screen.getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
    ['spec', 'false'], ['dev', 'true'], ['review', 'false'], ['sem fluxo', 'false'],
  ]);
  expect(screen.getByText('build')).toBeInTheDocument();
  expect(screen.getByText('ship')).toBeInTheDocument();
});

test('a stage posts move-to with it, sem fluxo posts leave-flow, the current entry posts nothing (#583)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<HiveStageMenu task={task('dev')} flows={FLOWS} />);
  await open(user, 'dev');
  await user.click(screen.getByRole('menuitemradio', { name: 'dev' }));
  await open(user, 'dev');
  await user.click(screen.getByRole('menuitemradio', { name: 'review' }));
  await open(user, 'dev');
  await user.click(screen.getByRole('menuitemradio', { name: 'sem fluxo' }));
  await waitFor(() => expect(posted()).toEqual([['/tasks/local%3A7/move-to', JSON.stringify({ stage: 'review' })], ['/tasks/local%3A7/leave-flow', undefined]]));
  unmount();
  render(<HiveStageMenu task={task()} flows={FLOWS} />); // outside the flow: the cell reads — and sem fluxo is the current entry
  await open(user, '—');
  expect(screen.getByRole('menuitemradio', { name: 'sem fluxo' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: 'sem fluxo' }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
