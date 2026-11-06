import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DiagramPane, drawioFrameUrl } from '@/components/DiagramPane';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';

const PATH = 'docs/arch.drawio';
const NAME = 'arch.drawio';
const LABEL = '#1 Task 1 · Diagrama arch.drawio';
const MODEL = '<diagram id="d"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram>';
const PLAIN = `<mxfile>${MODEL}</mxfile>`;
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const activity: Activity = { kind: 'task', ...taskPairOf('I1', { worktree: '/w/hive-1' }), task, runs: [], sessions: [], status: 'working', worker: true };

interface SaveBody { path: string; text: string; version: string; format: boolean }
interface HeldPut { body: SaveBody; answer(res: Response): void }
// What the routes answer: the file's text and version (null: gone), and every PUT held until the test answers it
let text = PLAIN;
let version: string | null = 'v1';
let readStatus = 200;
let puts: HeldPut[] = [];
const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === 'PUT') return new Promise((resolve) => { puts.push({ body: JSON.parse(String(init.body)) as SaveBody, answer: resolve }); });
  if (url.includes('/file-version')) return Promise.resolve(version === null ? jsonResponse({ error: 'file not found' }, 404) : jsonResponse({ version }));
  return Promise.resolve(readStatus === 200 ? jsonResponse({ path: PATH, text, version }) : jsonResponse({ error: 'too large' }, readStatus));
});

const pane = () => <DiagramPane activity={activity} path={PATH} label={LABEL} active />;
const frame = (): HTMLIFrameElement => screen.getByTitle(NAME);
const send = (data: unknown, source: Window | null = frame().contentWindow): void => {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
};
const fromFrame = (message: object): void => send(JSON.stringify(message));
const poll = (): void => { act(() => { window.dispatchEvent(new Event('focus')); }); }; // useFileVersion reads once on each focus
const flush = (): Promise<void> => act(async () => { await Promise.resolve(); });

// What the pane posted to its frame from now on, each message parsed back from its JSON string
function framePosts(): () => Record<string, unknown>[] {
  const win = frame().contentWindow;
  if (win === null) throw new Error('the frame has no window');
  const spy = vi.spyOn(win, 'postMessage').mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([data]) => JSON.parse(String(data)) as Record<string, unknown>);
}

// The pane rendered and draw.io's init answered with the file's load
async function opened(): Promise<() => Record<string, unknown>[]> {
  render(pane());
  const posts = framePosts();
  fromFrame({ event: 'init' });
  await waitFor(() => expect(posts()).toHaveLength(1));
  return posts;
}

async function autosaved(xml: string): Promise<void> {
  const before = puts.length;
  fromFrame({ event: 'autosave', xml });
  await waitFor(() => expect(puts).toHaveLength(before + 1));
}

beforeEach(() => {
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  text = PLAIN;
  version = 'v1';
  readStatus = 200;
  puts = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the frame loads the draw.io route with embed, proto=json, offline, stealth and lockdown, the Hive\'s theme and language, sandboxed to scripts with no referrer (#956)', () => {
  render(pane());
  const url = new URL(frame().getAttribute('src') ?? '', 'http://127.0.0.1');
  expect(url.pathname).toBe('/drawio/index.html');
  const params = ['embed', 'proto', 'offline', 'stealth', 'lockdown', 'dark', 'lang'].map((name) => url.searchParams.get(name));
  expect(params).toEqual(['1', 'json', '1', '1', '1', '1', 'pt-br']);
  expect(frame()).toHaveAttribute('sandbox', 'allow-scripts');
  expect(frame()).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(new URL(drawioFrameUrl('light', 'en'), 'http://127.0.0.1').searchParams.toString()).toMatch(/dark=0&lang=en$/);
  expect(screen.getByRole('region', { name: LABEL })).toBeInTheDocument();
});

test('init posts load with the file\'s XML, autosave on and no save or exit button (#956)', async () => {
  const posts = await opened();
  expect(posts()).toEqual([{ action: 'load', autosave: 1, noSaveBtn: 1, noExitBtn: 1, xml: PLAIN }]);
});

test('a message from another window, a non-JSON string or an object writes nothing; the same autosave from the frame\'s window PUTs its XML with format false (#956)', async () => {
  await opened();
  send(JSON.stringify({ event: 'autosave', xml: '<mxfile>other</mxfile>' }), window);
  send('not json');
  send({ event: 'autosave', xml: '<mxfile>object</mxfile>' });
  await flush();
  expect(puts).toHaveLength(0);
  await autosaved('<mxfile>moved</mxfile>');
  expect(puts[0].body).toEqual({ path: PATH, text: '<mxfile>moved</mxfile>', version: 'v1', format: false });
});

test('a pending XML posts load with its layout and without the marker, then the libavoid layout on the load event; the autosave that follows writes it (#956)', async () => {
  text = `<mxfile hive-layout="verticalFlow">${MODEL}</mxfile>`;
  const posts = await opened();
  expect(posts()[0]).toEqual({ action: 'load', autosave: 1, noSaveBtn: 1, noExitBtn: 1, xml: PLAIN, layout: 'verticalFlow' });
  fromFrame({ event: 'load', xml: '<mxfile>laid out</mxfile>' });
  expect(posts()[1]).toEqual({ action: 'layout', layouts: 'libavoid' });
  await flush();
  expect(puts).toHaveLength(0);
  await autosaved('<mxfile>routed</mxfile>');
  expect(puts[0].body.text).toBe('<mxfile>routed</mxfile>');
});

test('a pending Mermaid file posts load with a mermaid descriptor and writes the XML the load event answers (#956)', async () => {
  text = '<mxfile><hive-mermaid>flowchart TD\n  A --&gt; B</hive-mermaid></mxfile>';
  const posts = await opened();
  expect(posts()[0]).toEqual({ action: 'load', autosave: 1, noSaveBtn: 1, noExitBtn: 1, descriptor: { format: 'mermaid', data: 'flowchart TD\n  A --> B' } });
  fromFrame({ event: 'load', xml: '<mxfile>cells</mxfile>' });
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0].body).toEqual({ path: PATH, text: '<mxfile>cells</mxfile>', version: 'v1', format: false });
});

test('two autosaves during one PUT lead to one more PUT, with the second XML over the version the first answered (#956)', async () => {
  await opened();
  await autosaved('a');
  fromFrame({ event: 'autosave', xml: 'b' });
  fromFrame({ event: 'autosave', xml: 'c' });
  await flush();
  expect(puts).toHaveLength(1);
  await act(async () => { puts[0].answer(jsonResponse({ version: 'v2' })); });
  await waitFor(() => expect(puts).toHaveLength(2));
  expect(puts[1].body).toMatchObject({ text: 'c', version: 'v2' });
});

test('a 409 raises the strip and stops the writes; manter o meu writes the newest XML over the disk\'s version (#956)', async () => {
  await opened();
  await autosaved('a');
  await act(async () => { puts[0].answer(jsonResponse({ error: 'changed on disk', version: 'v9' }, 409)); });
  expect(await screen.findByText('mudou no disco')).toBeInTheDocument();
  fromFrame({ event: 'autosave', xml: 'b' });
  await flush();
  expect(puts).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'manter o meu' }));
  await waitFor(() => expect(puts).toHaveLength(2));
  expect(puts[1].body).toMatchObject({ text: 'b', version: 'v9' });
  expect(screen.queryByText('mudou no disco')).toBeNull();
});

test('recarregar drops the queued XML, reads the disk and posts its load (#956)', async () => {
  const posts = await opened();
  await autosaved('a');
  await act(async () => { puts[0].answer(jsonResponse({ error: 'changed on disk', version: 'v9' }, 409)); });
  text = `<mxfile>${MODEL}<!-- agent --></mxfile>`;
  version = 'v9';
  fireEvent.click(await screen.findByRole('button', { name: 'recarregar' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toMatchObject({ action: 'load', xml: text });
  expect(screen.queryByText('mudou no disco')).toBeNull();
  await flush();
  expect(puts).toHaveLength(1);
});

test('the disk changed under a clean pane: it reads the file and posts load again, writing nothing (#956)', async () => {
  const posts = await opened();
  text = `<mxfile>${MODEL}<!-- agent --></mxfile>`;
  version = 'v2';
  poll();
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toMatchObject({ action: 'load', xml: text });
  expect(puts).toHaveLength(0);
});

test('any other refusal shows in the bar and keeps the XML queued; a new disk version then raises the strip instead of reloading (#956)', async () => {
  const posts = await opened();
  await autosaved('a');
  await act(async () => { puts[0].answer(jsonResponse({ error: 'disk full' }, 500)); });
  expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  version = 'v2';
  poll();
  expect(await screen.findByText('mudou no disco')).toBeInTheDocument();
  expect(posts()).toHaveLength(1);
});

test('a file gone raises the missing strip and writes nothing; a refused read shows in the bar in the editor\'s words (#956)', async () => {
  await opened();
  version = null;
  poll();
  expect(await screen.findByText('arquivo não encontrado')).toBeInTheDocument();
  fromFrame({ event: 'autosave', xml: 'a' });
  await flush();
  expect(puts).toHaveLength(0);
});

test('a read refused on init shows its message in the bar (#956)', async () => {
  readStatus = 413;
  render(pane());
  fromFrame({ event: 'init' });
  expect(await screen.findByRole('alert')).toHaveTextContent('arquivo grande demais para o editor');
});
