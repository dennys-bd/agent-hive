import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HeaderSlotProvider, useHeaderSlotRef } from '@/components/HeaderSlot';
import { MainDock } from '@/components/MainDock';
import type { HeaderShell } from '@/hooks/use-header-shell';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import { CATALOGUE, itemOf, json, stubFetch, WORKSPACES } from './plugins-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// The header as the Dashboard's: its centre registers the slot the plugins head portals into; the shell's right panes as buttons
function SlotHeader({ shell }: { shell: HeaderShell }) {
  const register = useHeaderSlotRef();
  return (
    <header>
      <div ref={register} data-testid="head" />
      {(['files', 'details', 'variables'] as const).map((pane) => (
        <button key={pane} type="button" disabled={!shell.panes.enabled[pane]} onClick={() => shell.panes.pick(pane)}>{`pane ${pane}`}</button>
      ))}
    </header>
  );
}

function Window() {
  return (
    <HeaderSlotProvider>
      <MainDock
        fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={WORKSPACES} tasks={[]} workers={[]} terminals={[]}
        onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={(shell) => <SlotHeader shell={shell} />}
      >
        <main>fluxo</main>
      </MainDock>
    </HeaderSlotProvider>
  );
}

const key = (digit: string): void => { fireEvent.keyDown(window, { key: digit, code: `Digit${digit}`, ctrlKey: true }); };
const head = (): HTMLElement => screen.getByTestId('head');
const sidebar = (): HTMLElement => screen.getByRole('navigation', { name: 'Plugins' });
const listGroups = (): (string | null)[] => within(screen.getByRole('region', { name: 'skills' })).getAllByRole('group').map((g) => g.getAttribute('aria-label'));

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetViewState();
  resetFakes();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('Ctrl+3 opens plugins: the catalogue read on entering, the sidebar on the left, the skills list in the centre and its head in the header (#313)', async () => {
  const fetchMock = stubFetch();
  render(<Window />);
  expect(fetchMock.mock.calls.some(([path]) => path === '/api/items')).toBe(false);
  key('3');
  await waitFor(() => expect(within(head()).getByText('skills')).toBeInTheDocument());
  expect(head()).toHaveTextContent('da hive (plugin) e de cada workspace (a pasta skills dele)');
  expect(listGroups()).toEqual(['hive', 'agent-hive', 'hive-site']);
  expect(within(sidebar()).getByRole('button', { name: /^skills/ })).toHaveAttribute('aria-current', 'true');
});

test("the head's workspace filter keeps hive and that workspace; nova skill creates under it and opens the new item with its head (#313)", async () => {
  const user = userEvent.setup();
  let catalogue = CATALOGUE;
  stubFetch((body) => {
    const created = itemOf(`${(body as { origin?: string }).origin ?? 'hive'}:${(body as { name: string }).name}`);
    catalogue = [...catalogue, created];
    return json(created, 201);
  }, () => catalogue);
  render(<Window />);
  key('3');
  await user.click(await within(head()).findByRole('combobox', { name: 'workspaces' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  expect(listGroups()).toEqual(['hive', 'hive-site']);
  await user.click(within(head()).getByRole('button', { name: 'nova skill' }));
  await user.type(screen.getByRole('textbox', { name: 'nome da nova skill' }), 'preview{Enter}'); // the group starts on the filter's workspace
  await waitFor(() => expect(within(head()).getByText('preview')).toHaveClass('font-mono'));
  expect(within(head()).getByText('do workspace')).toBeInTheDocument();
  expect(within(sidebar()).getByRole('button', { name: /^preview/, current: true })).toBeInTheDocument();
});

test("an item opens its empty screen under its head: the mono name, the state chip in its colour, its section; mcp carries only its title, protocol its title and meta (#313, #337)", async () => {
  const user = userEvent.setup();
  stubFetch();
  render(<Window />);
  key('3');
  expect(within(sidebar()).queryAllByRole('group')).toEqual([]); // beside the list the side holds the sections alone
  await user.click(await within(screen.getByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-plan/ }));
  expect(within(sidebar()).getByRole('button', { name: /^new-plan/, current: true })).toBeInTheDocument();
  expect(within(head()).getByText('new-plan')).toHaveClass('font-mono');
  expect(within(head()).getByText('atualização disponível')).toHaveClass('text-waiting');
  expect(within(head()).getByText('skills')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'skills' })).not.toBeInTheDocument();
  await user.click(within(sidebar()).getByRole('button', { name: 'protocolo' }));
  expect(head()).toHaveTextContent(/^protocoloinjetado em toda sessão · trechos da hive travados · os seus entre eles$/);
});

test("in plugins arquivos and detalhes are off and the right group holds the empty variables pane, not the task's details; Ctrl+1 and Ctrl+2 still switch away, the head leaving with the view (#313)", async () => {
  stubFetch();
  render(<Window />);
  key('3');
  await waitFor(() => expect(within(head()).getByText('skills')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'pane files' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'pane details' })).toBeDisabled();
  fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true, altKey: true }); // toggleRight off macOS
  expect(screen.getByRole('region', { name: 'variáveis' })).toBeEmptyDOMElement();
  expect(screen.queryByText('detalhes')).not.toBeInTheDocument();
  key('2');
  expect(head()).toBeEmptyDOMElement();
  expect(screen.getByRole('main')).toHaveTextContent('fluxo');
  key('1');
  expect(screen.getByRole('button', { name: 'pane variables' })).toBeDisabled();
});
