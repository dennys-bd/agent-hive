import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isTrustedUrl, linkHandler, onTrust, setTrustedDomains, trustHost } from '@/lib/trusted-links';

const RANGE = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };
const click = (url: string, ask: (url: string) => void): void => linkHandler(ask).activate(new MouseEvent('click'), url, RANGE);
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => setTrustedDomains(['github.com']));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a host on the list trusts itself and its subdomains, in any case and on any port, never a look-alike or another scheme (#404)', () => {
  expect(['https://github.com/x', 'https://api.github.com/x', 'HTTP://GitHub.com:8443/a'].map(isTrustedUrl)).toEqual([true, true, true]);
  expect(['https://evilgithub.com', 'https://github.com.evil.io/', 'ftp://github.com/x', 'not a url'].map(isTrustedUrl)).toEqual([false, false, false, false]);
});

test('activate opens a trusted http(s) link at once, asks for another, and ignores file:, javascript: and a custom scheme (#404)', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const ask = vi.fn();
  click('https://github.com/acme/r/issues/1', ask);
  expect(open).toHaveBeenCalledWith('https://github.com/acme/r/issues/1');
  click('http://example.com/a', ask);
  expect(ask).toHaveBeenCalledWith('http://example.com/a');
  for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'vscode://file/x']) click(url, ask);
  expect([open.mock.calls.length, ask.mock.calls.length]).toEqual([1, 1]);
  expect(linkHandler(ask).allowNonHttpProtocols).toBe(false);
});

test('trustHost posts the host and trusts it once the route answers ok, telling onTrust; a refusal leaves it untrusted (#404)', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const heard = vi.fn();
  const stop = onTrust(heard);
  await trustHost('docs.example.com');
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([['/trusted-domains', 'POST', JSON.stringify({ host: 'docs.example.com' })]]);
  expect([isTrustedUrl('https://docs.example.com/guide'), heard.mock.calls.length]).toEqual([true, 1]);
  vi.stubGlobal('fetch', vi.fn(async () => answer(409, { error: 'Hive não configurado: salve as configurações primeiro' })));
  await expect(trustHost('other.example.com')).rejects.toThrow('Hive não configurado: salve as configurações primeiro');
  expect([isTrustedUrl('https://other.example.com/'), heard.mock.calls.length]).toEqual([false, 1]);
  stop();
});
