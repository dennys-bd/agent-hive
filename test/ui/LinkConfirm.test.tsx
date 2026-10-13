import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest';
import { LinkConfirm } from '@/components/LinkConfirm';
import { setLanguage } from '@/i18n';
import { isTrustedUrl, setTrustedDomains } from '@/lib/trusted-links';

const LINK = 'https://docs.example.com/guide?page=2';
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let open: MockInstance<typeof window.open>;

beforeEach(() => {
  setLanguage('pt');
  setTrustedDomains([]);
  open = vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the dialog shows the whole URL with its host in bold, and abrir opens it and closes (#404)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<LinkConfirm url={LINK} onClose={onClose} />);
  const dialog = screen.getByRole('alertdialog', { name: 'Abrir link' });
  expect(dialog).toHaveTextContent(LINK);
  expect(within(dialog).getByText('docs.example.com').tagName).toBe('STRONG');
  await user.click(within(dialog).getByRole('button', { name: 'abrir' }));
  expect(open).toHaveBeenCalledWith(LINK);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('cancelar and Escape open nothing; a host the route would refuse gets no Always trust (#404)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { unmount } = render(<LinkConfirm url={LINK} onClose={onClose} />);
  await user.click(within(screen.getByRole('alertdialog')).getByText('cancelar'));
  expect([open.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 1]);
  unmount();
  render(<LinkConfirm url="http://[::1]:3000/x" onClose={onClose} />);
  expect(screen.queryByRole('button', { name: /sempre confiar/ })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect([open.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 2]);
});

test('sempre confiar em <host> posts the host, then opens the link and closes; the host is trusted from then on (#404)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  render(<LinkConfirm url={LINK} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'sempre confiar em docs.example.com' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([['/trusted-domains', JSON.stringify({ host: 'docs.example.com' })]]);
  expect(open).toHaveBeenCalledWith(LINK);
  expect(isTrustedUrl(LINK)).toBe(true);
});

test('a refused trust shows the route\'s error in the dialog, which stays open, and opens nothing (#404)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => answer(409, { error: 'Hive não configurado: salve as configurações primeiro' })));
  render(<LinkConfirm url={LINK} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'sempre confiar em docs.example.com' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Hive não configurado: salve as configurações primeiro');
  expect([open.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 0]);
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(isTrustedUrl(LINK)).toBe(false);
});

test('Enter opens the link and closes; Ctrl+Enter (⌘ on macOS) trusts its host, then opens it (#75)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { unmount } = render(<LinkConfirm url={LINK} onClose={onClose} />);
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith(LINK);
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  render(<LinkConfirm url={LINK} onClose={onClose} />);
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/trusted-domains']);
  expect(open).toHaveBeenCalledTimes(2);
  expect(isTrustedUrl(LINK)).toBe(true);
});
