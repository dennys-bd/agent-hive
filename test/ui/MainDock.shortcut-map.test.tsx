import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

function Home({ flow = <main>fluxo</main>, openShortcuts }: { flow?: ReactNode; openShortcuts?: () => void }) {
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[]} workers={[]} terminals={[]}
      search={{ state: stateOf([]), openShortcuts }} onSelect={vi.fn()} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>}
      header={(_center, go) => <header><button type="button" onClick={() => go('automation')}>fluxo</button></header>}
    >
      {flow}
    </MainDock>
  );
}

// The shortcut map's key off macOS (#639): jsdom runs as off macOS, where CmdOrCtrl is Ctrl. false: the key was stopped and prevented
const mapKey = (target: Element | Window = window): boolean => fireEvent.keyDown(target, { key: '/', code: 'Slash', ctrlKey: true });
const map = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'atalhos' });

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('Ctrl+/ opens the shortcut map and Ctrl+/ again closes it, the focus going back where it was (#639)', async () => {
  render(<Home flow={<main><button type="button">alvo</button></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  const target = screen.getByRole('button', { name: 'alvo' });
  target.focus();
  mapKey(target);
  expect(map()).toBeInTheDocument();
  mapKey(document.activeElement ?? window); // the focus is inside the map now
  expect(map()).not.toBeInTheDocument();
  await waitFor(() => expect(target).toHaveFocus());
});

test('Ctrl+/ on a terminal\'s textarea opens the map too, the key never reaching the pty; Escape gives the focus back to it (#639)', async () => {
  const user = userEvent.setup();
  render(<Home flow={<main><textarea aria-label="terminal" /></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  const xterm = screen.getByRole('textbox', { name: 'terminal' }); // where xterm takes its keys
  xterm.focus();
  expect(mapKey(xterm)).toBe(false);
  expect(map()).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(map()).not.toBeInTheDocument();
  await waitFor(() => expect(xterm).toHaveFocus());
});

test('with the focus inside another dialog the key does nothing: the search stays as it is (#639)', () => {
  render(<Home />);
  fireEvent.keyDown(window, { key: 'F1', code: 'F1' }); // searchOperations off macOS (#585)
  mapKey(screen.getByRole('combobox', { name: 'busca' }));
  expect(map()).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'busca' })).toBeInTheDocument();
});

test('a Settings key field that is recording keeps the key (#449, #639)', () => {
  render(<Home flow={<main><button type="button" data-shortcut-recording="">gravando</button></main>} />);
  fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); // the board is the center (#746)
  expect(mapKey(screen.getByRole('button', { name: 'gravando' }))).toBe(true); // not prevented: the field records it
  expect(map()).not.toBeInTheDocument();
});

test('with the Settings page shown the key does nothing: the page holds the window as a dialog does (#510, #639)', () => {
  render(<><Home /><div data-settings-page="" /></>);
  mapKey();
  expect(map()).not.toBeInTheDocument();
});

test('the search lists the shortcut map among the global operations, and picking it opens the map (#584, #639)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  fireEvent.keyDown(window, { key: 'F1', code: 'F1' }); // searchOperations off macOS (#585)
  await user.keyboard('mapa');
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('o mapa de atalhos');
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('dialog', { name: 'atalhos' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'busca' })).not.toBeInTheDocument();
});

test('the map\'s link closes it, then opens Settings on the shortcuts (#639)', async () => {
  const user = userEvent.setup();
  const openShortcuts = vi.fn();
  render(<Home openShortcuts={openShortcuts} />);
  mapKey();
  await user.click(screen.getByRole('button', { name: 'editar em configurações › atalhos' }));
  expect(map()).not.toBeInTheDocument();
  expect(openShortcuts).toHaveBeenCalledOnce();
});
