import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { useOpenPr } from '@/components/terminal-tabs';
import type { BackEntry } from '@/hooks/use-back-stack';
import { setLanguage } from '@/i18n';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const PR = 'https://github.com/acme/app/pull/7';

// What a PR link and mostrar PR do (#758): hand the link to the dock's PR opener
function PrOpener() {
  const openPr = useOpenPr();
  return <button type="button" onClick={() => openPr?.(PR)}>pr</button>;
}
function Home({ openPr }: { openPr(url: string, from?: BackEntry): void }) {
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[]} workers={[]} terminals={[]} onSelect={() => {}}
      detail={() => <PrOpener />} automation={() => <p>automação</p>} openPr={openPr}
    >
      <main>fluxo</main>
    </MainDock>
  );
}

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const isFlowHidden = (): boolean => screen.getByText('fluxo', { selector: 'main' }).closest('[hidden]') !== null;

test('a PR opens through the Dashboard\'s opener with the flow shown under Automação; from Atividades it hands the entry that shows that view again (#758, #911)', () => {
  const openPr = vi.fn<(url: string, from?: BackEntry) => void>();
  render(<Home openPr={openPr} />);
  expect(isFlowHidden()).toBe(true); // the window opens on Atividades (#746), on Home: no activity picked
  fireEvent.click(screen.getByRole('button', { name: 'pr', hidden: true }));
  expect(openPr).toHaveBeenLastCalledWith(PR, expect.objectContaining({ label: 'atividades' }));
  expect(isFlowHidden()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'pr', hidden: true }));
  expect(openPr).toHaveBeenLastCalledWith(PR, undefined); // under Automação the Dashboard pushes the screen it leaves
  act(() => openPr.mock.calls[0][1]?.restore());
  expect(isFlowHidden()).toBe(true);
});
