import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bootRunHive, resetRunHive } from '@/components/benchmark/run-mode/run-hive';
import { Dashboard } from '@/components/Dashboard';
import { setLanguage, t } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import { stateWith } from '../benchmark/fixtures';
import { RUN, stubRunFetch } from './run-hive-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

beforeEach(() => { setLanguage('pt'); resetFakes(); resetViewState(); vi.stubGlobal('WebSocket', FakeWebSocket); });
afterEach(() => { resetRunHive(); vi.unstubAllGlobals(); });

async function dashboard(run: typeof RUN | undefined): Promise<void> {
  stubRunFetch(run);
  await bootRunHive();
  render(<Dashboard state={{ ...stateWith(), workspaces: ['hive'] }} locale="pt-BR" tick={0} onSelect={() => undefined} />);
}
const rail = (): HTMLElement => screen.getByRole('navigation', { name: t('rail.label') });

test('a dashboard whose GET /benchmark-run answers renders the run: run <token>, the breadcrumb, the band at 0, the footer\'s braço B · par 2 de 3 (#469)', async () => {
  await dashboard(RUN);
  expect(screen.getByText('run k9f2a6d1')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'caminho' })).toHaveTextContent('skills: comandos × plugin›Bskills do plugin›par 2');
  expect(screen.getByText('intervenções · 0')).toBeInTheDocument();
  expect(within(screen.getByRole('contentinfo')).getByText('braço B · par 2 de 3')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('header.openRight') })).toBeNull(); // no right sidebar
});

test('in run mode the rail dims plugins and benchmark, inert at .35, keeps atividades and fluxo, and drops its bottom icons (#469)', async () => {
  await dashboard(RUN);
  for (const name of ['plugins', 'benchmark']) {
    expect(within(rail()).getByRole('button', { name })).toBeDisabled();
    expect(within(rail()).getByRole('button', { name })).toHaveClass('opacity-35');
  }
  for (const name of ['atividades', 'fluxo']) expect(within(rail()).getByRole('button', { name })).toBeEnabled();
  expect(within(rail()).queryByRole('button', { name: t('rail.shortcutMap') })).toBeNull();
});

test('a 404 renders as today: no run brand, no band, the rail whole, the footer\'s own content (#469)', async () => {
  await dashboard(undefined);
  expect(screen.queryByText(/^run /)).toBeNull();
  expect(screen.queryByText(/^intervenções · /)).toBeNull();
  expect(within(rail()).getByRole('button', { name: 'plugins' })).toBeEnabled();
  expect(within(rail()).getByRole('button', { name: t('rail.shortcutMap') })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('header.openRight') })).toBeInTheDocument();
});
