import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalLines } from '@/components/TerminalLines';
import { setLanguage } from '@/i18n';

const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async () => answer({ ok: true, ptyId: 'T2' }));
const LIVE = { terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: false };
const ASLEEP = { terminalId: 'T2', label: 'Terminal 2', n: 2, asleep: true };

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('a live terminal\'s line opens its tab; a sleeping one wakes first, then opens; the shown one is marked (#696)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<TerminalLines terminals={[LIVE, ASLEEP]} shown="T1" onOpen={onOpen} />);
  const [live, asleep] = screen.getAllByRole('button');
  expect([live.textContent, asleep.textContent]).toEqual(['terminal 1', 'terminal 2dormindo']);
  expect(live).toHaveAttribute('aria-current', 'true');
  await user.click(live);
  expect([onOpen.mock.calls, fetchMock.mock.calls.length]).toEqual([[['T1']], 0]);
  await user.click(asleep);
  expect(fetchMock).toHaveBeenCalledWith('/terminals/T2/wake', expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith('T2'));
});
