import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage, t } from '@/i18n';
import { emitReadModelEvent } from '@/lib/review-events';
import { fakePrHive, type FakePrHive, prChanges, renderPage, ROUTE, thread } from './pr-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); vi.mocked(toast.error).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the title and the conversation show before …/changes answers; files shows the read line with no count, then the diff (#497)', async () => {
  const user = userEvent.setup();
  let release = (): void => undefined;
  hive.changesGate = new Promise<void>((resolve) => { release = resolve; });
  renderPage();
  expect(await screen.findByRole('heading', { name: 'The PR' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'descrição' })).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'arquivos' }));
  expect(screen.getByText('carregando…')).toBeInTheDocument();
  release();
  expect(await screen.findByRole('region', { name: 'src/a.ts' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'arquivos 1' })).toBeInTheDocument();
});

test('a failed …/changes is a message inside the files tab and no toast; the conversation still shows (#497)', async () => {
  const user = userEvent.setup();
  hive.answers[`GET ${ROUTE}/changes`] = { status: 502, body: { error: 'gh: boom' } };
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  await user.click(screen.getByRole('tab', { name: 'arquivos' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('pr.error.github'));
  expect(toast.error).not.toHaveBeenCalled();
});

test('a pullChanges event reads the changes again and their threads join the conversation (#497)', async () => {
  hive.changes = prChanges({ threads: [] });
  renderPage();
  expect(await screen.findByRole('tab', { name: 'conversa 0' })).toBeInTheDocument();
  hive.changes = prChanges({ threads: [thread()] });
  act(() => { emitReadModelEvent({ repository: 'acme/app', kinds: ['pullChanges'] }); });
  expect(await screen.findByRole('tab', { name: 'conversa 1' })).toBeInTheDocument();
});
