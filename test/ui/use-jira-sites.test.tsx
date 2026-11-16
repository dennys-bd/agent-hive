import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useJiraSites } from '@/hooks/use-jira-sites';
import { setLanguage, t } from '@/i18n';
import type { JiraSiteStatus } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const SITE = 'acme.atlassian.net';
const CONNECTED: JiraSiteStatus = { site: SITE, state: 'connected', name: 'Ana' };
const LOGIN = { site: 'https://Acme.atlassian.net/', email: 'ana@example.com', token: 'fake-token-817' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let listing: () => Response;
let written: () => Response;
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (init?.method === undefined ? listing() : written()));
const gets = (): number => fetchMock.mock.calls.filter(([, init]) => init?.method === undefined).length;

beforeEach(() => {
  setLanguage('en');
  listing = () => json([CONNECTED]);
  written = () => json(CONNECTED);
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('loads the sites once on mount (#817)', async () => {
  const { result } = renderHook(() => useJiraSites());
  expect(result.current.sites).toBeUndefined();
  await waitFor(() => expect(result.current.sites).toEqual([CONNECTED]));
  expect(fetchMock).toHaveBeenCalledWith('/settings/jira/sites');
  expect(gets()).toBe(1);
});

test('a non-array answer reads as no site; a failed listing shows the generic toast (#817)', async () => {
  listing = () => json({});
  const first = renderHook(() => useJiraSites());
  await waitFor(() => expect(first.result.current.sites).toEqual([]));
  listing = () => json({ error: 'boom' }, 500);
  renderHook(() => useJiraSites());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('settings.connections.jira.failed')));
});

test('connect posts the login with x-hive-ui, answers connected and reloads the sites (#817)', async () => {
  listing = () => json([]);
  const { result } = renderHook(() => useJiraSites());
  await waitFor(() => expect(result.current.sites).toEqual([]));
  listing = () => json([CONNECTED]);
  let outcome: string | undefined;
  await act(async () => { outcome = await result.current.connect(LOGIN); });
  expect(outcome).toBe('connected');
  const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(url).toBe('/settings/jira/sites');
  expect(JSON.parse(String(init?.body))).toEqual(LOGIN);
  const headers = init?.headers as Record<string, string>;
  expect(headers['x-hive-ui']).toBe('1');
  expect(result.current.sites).toEqual([CONNECTED]);
});

test('a refusal answers its code with no toast and no reload; any other failure answers failed with the toast (#817)', async () => {
  const { result } = renderHook(() => useJiraSites());
  await waitFor(() => expect(result.current.sites).toBeDefined());
  for (const code of ['invalid-site', 'refused', 'unreachable'] as const) {
    written = () => json({ error: code }, 400);
    await act(async () => { expect(await result.current.connect(LOGIN)).toBe(code); });
  }
  expect(toast.error).not.toHaveBeenCalled();
  expect(gets()).toBe(1);
  written = () => json({ error: 'jira site not saved' }, 500);
  await act(async () => { expect(await result.current.connect(LOGIN)).toBe('failed'); });
  expect(toast.error).toHaveBeenCalledWith(t('settings.connections.jira.failed'));
});

test('disconnect sends DELETE to the encoded site and reloads; a failed one shows the toast (#817)', async () => {
  const { result } = renderHook(() => useJiraSites());
  await waitFor(() => expect(result.current.sites).toEqual([CONNECTED]));
  written = () => new Response(null, { status: 204 });
  listing = () => json([]);
  await act(async () => { await result.current.disconnect(SITE); });
  expect(fetchMock).toHaveBeenCalledWith(`/settings/jira/sites/${encodeURIComponent(SITE)}`, expect.objectContaining({ method: 'DELETE' }));
  expect(result.current.sites).toEqual([]);
  written = () => json({ error: 'jira site not removed' }, 500);
  await act(async () => { await result.current.disconnect(SITE); });
  expect(toast.error).toHaveBeenCalledWith(t('settings.connections.jira.failed'));
});
