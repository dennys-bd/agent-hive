import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SetupProgressView } from '@/components/SetupProgress';
import { ConsoleContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import type { SetupRow, SetupRowStatus } from '../../src/types';

const CONSOLE = 'setup:I9';
const SESSION = 'iniciar sessão claude na etapa backlog';
const HISTORY = ['── #9 · setup · 10:00:00 ──', '> git -C /repo worktree add', 'ok 120ms', '> RUN pnpm install', 'added 12 packages', 'ok 34000ms', '> RUN pnpm build', 'building'].join('\r\n');
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const step = (label: string, status: SetupRowStatus, extra: Partial<SetupRow> = {}): SetupRow => ({ kind: 'step', status, label, header: `RUN ${label}`, ...extra });
const PREPARED: SetupRow[] = [{ kind: 'worktree', status: 'done', durationMs: 1200 }, { kind: 'branch', status: 'done', branch: 'hive/9-landing-hero', base: 'origin/main' }];
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const view = (rows: SetupRow[], extra: { status?: SetupRowStatus; isFailed?: boolean; onClose?: () => void; onRetry?: () => void } = {}) => (
  <SetupProgressView progress={{ consoleId: CONSOLE, rows }} isLive={false} isFailed={extra.isFailed ?? false}
    session={{ text: SESSION, status: extra.status ?? 'queued' }} onClose={extra.onClose ?? vi.fn()} onRetry={extra.onRetry ?? vi.fn()} />
);
const rowOf = (text: string): HTMLElement => screen.getAllByText(text).flatMap((el) => el.closest('li') ?? [])[0];

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async () => reply({ history: HISTORY, live: [], status: 'running' }))); });
afterEach(() => vi.unstubAllGlobals());

test('each row shows its icon and value: a time when done, executando and its clock, aguardando, falhou with its exit code, its timeout or nothing more (#390)', () => {
  render(view([...PREPARED, step('pnpm install', 'running', { startedAt: ago(34_000) }), step('pnpm build', 'queued'),
    step('pnpm a', 'failed', { code: '1' }), step('pnpm b', 'failed', { code: 'timeout' }), step('COPY .env', 'failed')]));
  expect(rowOf('worktree criada')).toHaveTextContent('1s');
  expect(rowOf('worktree criada').querySelector('svg')).not.toBeNull(); // lucide check
  expect(rowOf('hive/9-landing-hero')).toHaveTextContent('branch hive/9-landing-hero a partir de origin/main');
  expect(rowOf('pnpm install')).toHaveTextContent(/●.*setup · pnpm install.*executando · 3\ds/);
  expect(rowOf('pnpm build')).toHaveTextContent(/○.*aguardando/);
  expect(rowOf('pnpm a')).toHaveTextContent(/×.*falhou · exit 1/);
  expect(rowOf('pnpm b')).toHaveTextContent('falhou · timeout');
  expect(rowOf('COPY .env')).toHaveTextContent(/falhou$/);
  expect(screen.getByText(/^pode fechar: o setup continua em segundo plano/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'preparando worktree…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'fechar' })).toBeEnabled();
});

test('the bar is the rows done over all of them, the session row included; the session row is queued, running or done (#390)', () => {
  const { rerender } = render(view([...PREPARED, step('pnpm install', 'running', { startedAt: ago(0) }), step('pnpm build', 'queued')]));
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'); // 2 of 5
  expect(rowOf(SESSION)).toHaveTextContent('○');
  const done = [...PREPARED, step('pnpm install', 'done', { durationMs: 1000 }), step('pnpm build', 'done', { durationMs: 1000 })];
  rerender(view(done, { status: 'running' }));
  expect(rowOf(SESSION)).toHaveTextContent('●');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
  rerender(view(done, { status: 'done' }));
  expect(rowOf(SESSION).querySelector('svg')).not.toBeNull();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
});

test('the log follows the running row; a pick of another stays on it until the running row is picked again (#390)', async () => {
  const user = userEvent.setup();
  const select = (): HTMLElement => screen.getByRole('combobox', { name: 'log' });
  const at = ago(0);
  const { rerender } = render(view([...PREPARED, step('pnpm install', 'done', { durationMs: 34_000 }), step('pnpm build', 'running', { startedAt: at }), step('pnpm test', 'queued'), step('pnpm lint', 'queued')]));
  await waitFor(() => expect(screen.getByText('building')).toBeInTheDocument());
  expect(select()).toHaveTextContent('pnpm build');
  const testing = [...PREPARED, step('pnpm install', 'done', { durationMs: 34_000 }), step('pnpm build', 'done', { durationMs: 9_000 }), step('pnpm test', 'running', { startedAt: at }), step('pnpm lint', 'queued')];
  rerender(view(testing));
  expect(select()).toHaveTextContent('pnpm test');
  await user.click(select());
  await user.click(screen.getByRole('option', { name: 'pnpm install' }));
  expect(screen.getByText('added 12 packages')).toBeInTheDocument();
  rerender(view([...testing])); // a new list, the same running row
  expect(select()).toHaveTextContent('pnpm install');
  await user.click(select());
  await user.click(screen.getByRole('option', { name: 'pnpm test' }));
  rerender(view([...testing.slice(0, 4), step('pnpm test', 'done', { durationMs: 2_000 }), step('pnpm lint', 'running', { startedAt: at })]));
  expect(select()).toHaveTextContent('pnpm lint');
});

test('abrir no console opens the run in the console and closes the dialog; a failed view offers tentar de novo (#390)', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const onClose = vi.fn();
  const onRetry = vi.fn();
  render(<ConsoleContext.Provider value={open}>{view([...PREPARED, step('pnpm install', 'failed', { durationMs: 40, code: '1' })], { isFailed: true, onClose, onRetry })}</ConsoleContext.Provider>);
  await user.click(screen.getByRole('button', { name: 'abrir no console' }));
  expect(open).toHaveBeenCalledWith('setup', CONSOLE, true);
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'tentar de novo' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

const LONG = 'pnpm install --frozen-lockfile && \\\n  pnpm -r build && pnpm exec playwright install --with-deps chromium'; // a multi-line RUN

test('a long setup command and the branch stay on one line, cut with an ellipsis, their full text in the row\'s title; the value never shrinks (#893)', () => {
  render(view([...PREPARED, step(LONG, 'running', { startedAt: ago(0) })]));
  const rows = screen.getAllByRole('listitem');
  const setup = rows.find((li) => li.getAttribute('title') === `setup · ${LONG}`);
  expect(setup).toBeDefined();
  if (setup === undefined) return;
  expect(within(setup).getByText(/pnpm install --frozen-lockfile/).parentElement).toHaveClass('min-w-0', 'flex-1', 'truncate'); // jsdom lays nothing out: the one line is checked by eye
  expect(within(setup).getByText(/^executando · /)).toHaveClass('flex-none', 'whitespace-nowrap');
  expect(rows.some((li) => li.getAttribute('title') === 'branch hive/9-landing-hero a partir de origin/main')).toBe(true);
});

test('the log select opens under its trigger, at most the log box wide, each item on one line with its full text in title; the trigger cuts too (#893)', async () => {
  const user = userEvent.setup();
  render(view([...PREPARED, step(LONG, 'done', { durationMs: 1000 }), step('pnpm build', 'running', { startedAt: ago(0) })]));
  const select = screen.getByRole('combobox', { name: 'log' });
  expect(select).toHaveClass('min-w-0', 'max-w-[60%]');
  await user.click(select);
  select.focus();
  await user.keyboard('{Enter}'); // a click here is swallowed after another test's userEvent in this file
  const list = screen.getByRole('listbox');
  expect(list).toHaveAttribute('data-side'); // set by the popper position alone; item-aligned has none
  expect(list).toHaveClass('max-w-(--radix-select-content-available-width)');
  expect(screen.getByRole('option', { name: /pnpm install --frozen-lockfile/ })).toHaveAttribute('title', LONG);
  expect(screen.getByRole('option', { name: 'pnpm build' })).toHaveAttribute('title', 'pnpm build');
});

const nested = (path: string, status: SetupRowStatus, extra: Partial<SetupRow> = {}): SetupRow => ({ kind: 'nested', status, label: path, header: `nested ${path}`, ...extra });
const NESTED_ROWS = (): SetupRow[] => [...PREPARED,
  nested('docs', 'done', { durationMs: 2000, branch: 'hive/9-landing-hero', base: 'origin/main' }), nested('wiki', 'done', { durationMs: 100, branch: 'hive/9-landing-hero' }),
  nested('ee', 'failed'), nested('notes', 'running', { startedAt: ago(3000) }), nested('more', 'queued')];

test('a nested repo\'s row: its path while queued, running or failed; once done its branch and base, or reaproveitada; the bar counts it; in both languages (#450)', () => {
  const { unmount } = render(view(NESTED_ROWS()));
  expect(rowOf('docs')).toHaveTextContent(/repo aninhado docs · branch hive\/9-landing-hero a partir de origin\/main\s*2s/);
  expect(rowOf('docs')).toHaveAttribute('title', 'repo aninhado docs · branch hive/9-landing-hero a partir de origin/main');
  expect(rowOf('wiki')).toHaveTextContent('repo aninhado wiki · branch hive/9-landing-hero reaproveitada');
  expect(rowOf('ee')).toHaveTextContent(/×.*repo aninhado ee.*falhou$/);
  expect(rowOf('notes')).toHaveTextContent(/●.*repo aninhado notes.*executando · /);
  expect(rowOf('more')).toHaveTextContent(/○.*repo aninhado more.*aguardando/);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50'); // 4 done of 8 (7 rows and the session)
  unmount();
  setLanguage('en');
  render(view(NESTED_ROWS()));
  expect(rowOf('docs')).toHaveTextContent('nested repo docs · branch hive/9-landing-hero from origin/main');
  expect(rowOf('wiki')).toHaveTextContent('nested repo wiki · branch hive/9-landing-hero reused');
  expect(rowOf('ee')).toHaveTextContent(/nested repo ee.*failed$/);
  expect(rowOf('more')).toHaveTextContent(/nested repo more.*waiting/);
});

test('the log follows a running nested repo and names it repo aninhado <path> (#450)', () => {
  render(view([...PREPARED, nested('docs', 'running', { startedAt: ago(0) }), nested('wiki', 'queued'), step('pnpm install', 'queued')]));
  expect(screen.getByRole('combobox', { name: 'log' })).toHaveTextContent('repo aninhado docs');
});
