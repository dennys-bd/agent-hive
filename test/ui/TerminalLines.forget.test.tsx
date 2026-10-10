import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalLines } from '@/components/TerminalLines';
import { setLanguage } from '@/i18n';

// Its own file: Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx)
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('a sleeping terminal\'s right-click offers esquecer, in the destructive colour, which posts its forget (#696)', async () => {
  render(<TerminalLines terminals={[{ terminalId: 'T2', label: 'Terminal', asleep: true }]} onOpen={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: /^terminal/ }));
  const forget = await screen.findByRole('menuitem', { name: 'esquecer' });
  expect(forget).toHaveClass('text-destructive');
  fireEvent.click(forget);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/terminals/T2/forget', expect.objectContaining({ method: 'POST' })));
});
