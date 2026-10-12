import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { setLanguage } from '@/i18n';
import { rememberFocus } from '@/lib/session-focus';
import { FRAME_NAME, fromBridge, mintFrame, PATH, RECT, REVIEW } from './design-review';
import { activityOf, callsTo, fakeHive, type FakeHive, SESSION, withSessions } from './diff-harness';

const ELEMENT = { kind: 'element', selector: 'main > h1:nth-of-type(1)', text: 'Welcome', rect: RECT };
const AREA = { kind: 'area', rect: { x: 40, y: 60, width: 320.4, height: 179.6 } };
const ON_PATH = { path: PATH, viewport: 1280, theme: 'dark' };

let hive: FakeHive;
beforeEach(() => {
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  hive = fakeHive();
  hive.review = REVIEW;
  mintFrame(hive);
  rememberFocus('I1', SESSION); // the footer's recipient: the session in focus
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

async function pane(): Promise<void> {
  render(<DesignPane activity={activityOf(withSessions())} path={PATH} label="#1 Task 1 · Design Landing.hv.html" active />);
  await screen.findByTitle(FRAME_NAME);
  await screen.findByText('a draft');
}
const toggle = (): HTMLElement => screen.getByRole('button', { name: 'comentar' });
const composer = (): HTMLElement | null => screen.queryByRole('group', { name: 'comentar' });
const field = (): HTMLElement => screen.getByRole('textbox', { name: 'comentar' });
const anchor = (target: Record<string, unknown>): void => fromBridge({ type: 'anchor', anchor: target });
const posted = (url: string): unknown[] => callsTo(hive, 'POST', `/tasks/I1/review${url}`).map((c) => c.body);

test('an element anchor in comment mode opens the composer headed by its selector, an area by its size; a new anchor re-aims it and keeps the text (#114)', async () => {
  const user = userEvent.setup();
  await pane();
  anchor(ELEMENT);
  expect(composer()).toBeNull(); // out of comment mode
  await user.click(toggle());
  anchor(ELEMENT);
  expect(within(composer()!).getByText('main > h1:nth-of-type(1)')).toBeInTheDocument();
  expect(within(composer()!).getByText('7')).toBeInTheDocument(); // the pin the server gives next
  expect(within(composer()!).getByText('esc cancela')).toBeInTheDocument();
  expect(field()).toHaveFocus();
  await user.type(field(), 'bigger');
  anchor(AREA);
  expect(within(composer()!).getByText('área · 320×180')).toBeInTheDocument();
  expect(field()).toHaveValue('bigger');
});

test('adicionar, by ↵ or its button, saves a draft with the path, the viewport\'s width, the theme and the recipient, then closes with the mode on; a refusal keeps the text (#114)', async () => {
  const user = userEvent.setup();
  await pane();
  await user.click(toggle());
  anchor(ELEMENT);
  await user.type(field(), 'bigger{Enter}');
  await waitFor(() => expect(composer()).toBeNull());
  expect(posted('/drafts')).toEqual([{ anchor: { ...ELEMENT, ...ON_PATH }, text: 'bigger', session: SESSION }]);
  expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input) === '/tasks/I1/review/drafts' ? new Response(JSON.stringify({ error: 'no' }), { status: 500 }) : inner(input, init))));
  anchor(AREA);
  await user.type(field(), 'again');
  await user.click(screen.getByRole('button', { name: 'adicionar' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'adicionar' })).toBeEnabled());
  expect(field()).toHaveValue('again');
});

test('enviar agora, by its button or ⌘↵, sends that one comment to the recipient and no draft (#114)', async () => {
  const user = userEvent.setup();
  await pane();
  await user.click(toggle());
  anchor(ELEMENT);
  await user.type(field(), 'now');
  await user.click(screen.getByRole('button', { name: 'enviar agora' }));
  await waitFor(() => expect(composer()).toBeNull());
  anchor(AREA);
  await user.type(field(), 'too{Control>}{Enter}{/Control}'); // ⌘↵ off macOS
  await waitFor(() => expect(posted('/threads')).toHaveLength(2));
  expect(posted('/threads')).toEqual([
    { anchor: { ...ELEMENT, ...ON_PATH }, text: 'now', to: [SESSION] },
    { anchor: { ...AREA, ...ON_PATH }, text: 'too', to: [SESSION] },
  ]);
  expect([posted('/drafts'), posted('/submit')]).toEqual([[], []]);
});

test('an empty text disables both buttons and both keys; esc closes the composer, a second esc turns comment mode off (#114)', async () => {
  const user = userEvent.setup();
  await pane();
  await user.click(toggle());
  anchor(ELEMENT);
  expect(screen.getByRole('button', { name: 'adicionar' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'enviar agora' })).toBeDisabled();
  await user.type(field(), '   {Enter}{Control>}{Enter}{/Control}');
  expect([posted('/drafts'), posted('/threads')]).toEqual([[], []]);
  await user.keyboard('{Escape}');
  expect(composer()).toBeNull();
  expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  await user.keyboard('{Escape}'); // the closed composer handed the focus back to the pane
  expect(toggle()).toHaveAttribute('aria-pressed', 'false');
});
