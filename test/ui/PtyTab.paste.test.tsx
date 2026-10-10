import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PtyTab } from '@/components/PtyTab';
import type { RunTab } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { terminalPaste } from '@/lib/xterm-setup';
import { FakeTerminal, FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
// The paste itself is xterm-setup.test.tsx's; here only what the tab hands it (#843)
vi.mock('@/lib/xterm-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/xterm-setup')>()), terminalPaste: vi.fn(),
}));

// A task's stage run, what the test attaches
const STAGE: RunTab = { ptyId: 'W1', kind: 'stage', task: 'I1', title: '#1 Task 1' };

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the tab hands its xterm to terminalPaste once it is open, with the main window\'s Finder files read at each paste, and none outside the viewer (#843)', async () => {
  const open = vi.spyOn(FakeTerminal.prototype, 'open');
  vi.stubGlobal('hive', { clipboardFiles: vi.fn(async () => ['/tmp/shot.png']) });
  render(<PtyTab tab={STAGE} label="#1 Task 1 · etapa" active fileLinks={false} fontFamily="ui-monospace, monospace" onExit={vi.fn()} />);
  const paste = vi.mocked(terminalPaste);
  expect(paste).toHaveBeenCalledOnce();
  const [term, files] = paste.mock.calls[0];
  expect(term).toBe(FakeTerminal.all[0]);
  expect(paste.mock.invocationCallOrder[0]).toBeGreaterThan(open.mock.invocationCallOrder[0]); // xterm's element exists only after open
  await expect(files()).resolves.toEqual(['/tmp/shot.png']);
  vi.stubGlobal('hive', undefined); // a plain browser: no bridge, read at the paste
  await expect(files()).resolves.toEqual([]);
});
