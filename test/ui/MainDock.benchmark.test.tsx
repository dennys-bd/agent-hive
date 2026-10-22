import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HeaderSlotProvider, useHeaderSlotRef } from '@/components/HeaderSlot';
import { MainDock } from '@/components/MainDock';
import type { HeaderShell } from '@/hooks/use-header-shell';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { Experiment } from '../../src/types';
import { ARCHIVED, EXPERIMENTS, RUNNING, stubBenchmarkFetch, WORKSPACES } from './benchmark-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

function SlotHeader({ shell }: { shell: HeaderShell }) {
  const register = useHeaderSlotRef();
  return (
    <header>
      <div ref={register} data-testid="head" />
      {(['files', 'details', 'variables'] as const).map((pane) => <button key={pane} type="button" disabled={!shell.panes.enabled[pane]}>{`pane ${pane}`}</button>)}
    </header>
  );
}

function Window({ experiments = EXPERIMENTS }: { experiments?: Experiment[] }) {
  return (
    <HeaderSlotProvider>
      <MainDock
        fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={WORKSPACES} tasks={[]} workers={[]} terminals={[]} experiments={experiments}
        onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={(shell) => <SlotHeader shell={shell} />}
      >
        <main>fluxo</main>
      </MainDock>
    </HeaderSlotProvider>
  );
}

const key = (digit: string): void => { fireEvent.keyDown(window, { key: digit, code: `Digit${digit}`, ctrlKey: true }); };
const head = (): HTMLElement => screen.getByTestId('head');
const sidebar = (): HTMLElement => screen.getByRole('navigation', { name: 'experimentos' });
const tabs = (): HTMLElement => screen.getByRole('navigation', { name: 'experimento' });

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetViewState();
  resetFakes();
  stubBenchmarkFetch();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('Ctrl+4 opens benchmark: the sidebar on the left, the first experiment selected, its head in the header and braços the shown tab with its placeholder (#461)', () => {
  render(<Window />);
  key('4');
  expect(within(sidebar()).getByRole('button', { name: new RegExp(`^${RUNNING.name}`) })).toHaveAttribute('aria-current', 'true');
  expect(head()).toHaveTextContent(RUNNING.name);
  expect(within(tabs()).getAllByRole('button').map((b) => b.textContent)).toEqual(['braços', 'config', 'comparar', 'execução', 'relatório']);
  expect(within(tabs()).getByRole('button', { name: 'braços' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByText('em breve')).toBeInTheDocument();
});

test('a click on another row selects it, a tab click switches the tab, and both survive a switch of view (#461)', async () => {
  const user = userEvent.setup();
  render(<Window />);
  key('4');
  await user.click(within(sidebar()).getByRole('button', { name: /^opus no plan/ }));
  await user.click(within(tabs()).getByRole('button', { name: 'comparar' }));
  key('2');
  expect(head()).toBeEmptyDOMElement();
  key('4');
  expect(head()).toHaveTextContent('opus no plan');
  expect(within(tabs()).getByRole('button', { name: 'comparar' })).toHaveAttribute('aria-current', 'page');
});

test('the panes are off, panel-right opens an empty right column, not the task details; Ctrl+3 still opens plugins (#461)', () => {
  render(<Window />);
  key('4');
  for (const pane of ['files', 'details', 'variables']) expect(screen.getByRole('button', { name: `pane ${pane}` })).toBeDisabled();
  fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true, altKey: true }); // toggleRight off macOS
  expect(screen.getByRole('region', { name: 'Benchmark' })).toBeEmptyDOMElement();
  expect(screen.queryByText('detalhes')).not.toBeInTheDocument();
});

test('with no live experiment the centre shows the empty state and its experimento vazio, no head and no tabs (#461)', async () => {
  render(<Window experiments={[ARCHIVED]} />);
  key('4');
  expect(screen.getByText('nenhum experimento ainda')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'experimento vazio' })).toBeInTheDocument();
  expect(head()).toBeEmptyDOMElement();
  expect(screen.queryByRole('navigation', { name: 'experimento' })).not.toBeInTheDocument();
  await waitFor(() => expect(within(sidebar()).getByRole('button', { name: 'arquivados · 1' })).toBeInTheDocument());
});
