import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import type { ReviewDraft, ReviewFile } from '../../src/types';
import { area, FRAME_NAME, fromBridge, mintFrame, PATH, postsToFrame } from './design-review';
import { activityOf, fakeHive, type FakeHive, SESSION, withSessions } from './diff-harness';

type User = ReturnType<typeof userEvent.setup>;
const BLOCK = { viewports: ['mobile'], layout: { options: ['board', 'list'], default: 'board' }, auto: { type: 'boolean', default: true } };
const draft = (pin: number, text: string, state: Parameters<typeof area>[2] = {}): ReviewDraft => ({ id: `D${pin}`, anchor: area(pin, PATH, state), session: SESSION, text });
// One comment per state the pane can be in, and one on a tweak the block no longer has
const STATES: ReviewFile = {
  reviewed: [], threads: [], drafts: [
    draft(1, 'on the default'), draft(2, 'on the list', { tweaks: { layout: 'list' } }), draft(3, 'on mobile', { viewport: 'mobile' }),
    draft(4, 'in light', { theme: 'light' }), draft(5, 'on a gone tweak', { tweaks: { gone: 'x' } }),
    draft(6, 'on mobile, light, list', { viewport: 'mobile', theme: 'light', tweaks: { layout: 'list', auto: false } }),
  ],
};
const tweak = (name: string, value: unknown): Record<string, unknown> => ({ hive: 'design', type: 'tweak', name, value });
const ofType = (posts: Record<string, unknown>[], type: string): Record<string, unknown>[] => posts.filter((data) => data.type === type);
const row = (): HTMLElement | null => screen.queryByRole('toolbar', { name: 'tweaks' });

let hive: FakeHive;
beforeEach(() => {
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  showCommentsPanel(false);
  hive = fakeHive();
  hive.review = STATES;
  mintFrame(hive);
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pane(): Promise<void> {
  render(<DesignPane activity={activityOf(withSessions())} path={PATH} label="#1 Task 1 · Design Landing.hv.html" active />);
  await screen.findByTitle(FRAME_NAME);
  await waitFor(() => expect(screen.getByRole('button', { name: 'comentários' })).toHaveTextContent('6'));
}
async function pick(user: User, name: string, option: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(screen.getByRole('option', { name: option }));
}

test('no row before or without a block; the frame\'s block shows it and sends the defaults, and a change sends that tweak (#241)', async () => {
  const user = userEvent.setup();
  await pane();
  expect(row()).toBeNull();
  const posts = postsToFrame();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  expect(ofType(posts(), 'tweak')).toEqual([tweak('layout', 'board'), tweak('auto', true)]);
  await user.click(screen.getByRole('switch', { name: 'auto' }));
  expect(ofType(posts(), 'tweak').at(-1)).toEqual(tweak('auto', false));
  expect(screen.getByRole('switch', { name: 'auto' })).not.toBeChecked();
});

test('after every ready the values go again, after the theme; a new block settles them and sends them at once (#241)', async () => {
  const user = userEvent.setup();
  await pane();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  await pick(user, 'layout', 'list');
  const posts = postsToFrame();
  fromBridge({ type: 'ready' });
  expect(posts().slice(-3)).toEqual([{ hive: 'design', type: 'theme', theme: 'dark' }, tweak('layout', 'list'), tweak('auto', true)]);
  fromBridge({ type: 'tweaks', schema: { layout: { options: ['board', 'grid'], default: 'grid' } } });
  expect(ofType(posts(), 'tweak').at(-1)).toEqual(tweak('layout', 'grid')); // list left the block: the default
  expect(screen.getByRole('combobox', { name: 'layout' })).toHaveTextContent('grid');
  expect(screen.queryByRole('switch', { name: 'auto' })).toBeNull();
});

test('a block whose JSON broke, or whose rules fail, shows the invalid message and no control (#241)', async () => {
  await pane();
  fromBridge({ type: 'tweaks', schema: null, error: 'json' });
  expect(row()).toHaveTextContent('o bloco hv-tweaks é inválido');
  fromBridge({ type: 'tweaks', schema: { Layout: { options: ['a'], default: 'a' } } });
  expect(row()).toHaveTextContent('o bloco hv-tweaks é inválido');
  expect(screen.queryByRole('combobox', { name: 'Layout' })).toBeNull();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  expect(screen.getByRole('combobox', { name: 'layout' })).toBeInTheDocument();
});

test('an empty block shows no row, an invalid one still does (#241)', async () => {
  await pane();
  fromBridge({ type: 'tweaks', schema: {} });
  expect(row()).toBeNull();
  fromBridge({ type: 'tweaks', schema: null, error: 'json' });
  expect(row()).toHaveTextContent('o bloco hv-tweaks é inválido');
  fromBridge({ type: 'tweaks', schema: {} });
  expect(row()).toBeNull();
});

test('a default changed in the file reaches the pane on reload, while a value the user picked survives it when it still fits (#241)', async () => {
  const user = userEvent.setup();
  await pane();
  const posts = postsToFrame();
  const sizes = (dflt: string): unknown => ({ density: { options: ['compact', 'roomy'], default: dflt }, layout: { options: ['board', 'list'], default: 'board' } });
  fromBridge({ type: 'tweaks', schema: sizes('compact') });
  fromBridge({ type: 'tweaks', schema: sizes('roomy') });
  expect(ofType(posts(), 'tweak').at(-2)).toEqual(tweak('density', 'roomy'));
  expect(screen.getByRole('combobox', { name: 'density' })).toHaveTextContent('roomy');
  await pick(user, 'layout', 'list');
  fromBridge({ type: 'tweaks', schema: sizes('compact') });
  expect(screen.getByRole('combobox', { name: 'density' })).toHaveTextContent('compact');
  expect(screen.getByRole('combobox', { name: 'layout' })).toHaveTextContent('list');
});

const anchored = (posts: Record<string, unknown>[]): string[] =>
  ((ofType(posts, 'anchors').at(-1)?.anchors ?? []) as { id: string }[]).map((entry) => entry.id);

test('only the comments made on the pane\'s viewport, theme and tweaks go to the frame as anchors; a tweak gone from the block is ignored (#241)', async () => {
  const user = userEvent.setup();
  await pane();
  const posts = postsToFrame();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  expect(anchored(posts())).toEqual(['D1', 'D5']);
  await pick(user, 'layout', 'list');
  expect(anchored(posts())).toEqual(['D2']);
  await user.click(screen.getByRole('radio', { name: 'mobile' }));
  await user.click(screen.getByRole('radio', { name: 'claro' }));
  await user.click(screen.getByRole('switch', { name: 'auto' }));
  expect(anchored(posts())).toEqual(['D6']);
});

test('a comment chosen in the list switches the pane to its viewport, theme and tweaks, then scrolls to it once the frame has its anchor (#241)', async () => {
  const user = userEvent.setup();
  showCommentsPanel(true);
  await pane();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  const posts = postsToFrame();
  await user.click(screen.getByText('on mobile, light, list'));
  expect(screen.getByRole('radio', { name: 'mobile' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'claro' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('combobox', { name: 'layout' })).toHaveTextContent('list');
  expect(screen.getByRole('switch', { name: 'auto' })).not.toBeChecked();
  const sent = posts();
  expect(ofType(sent, 'theme')).toEqual([{ hive: 'design', type: 'theme', theme: 'light' }]);
  expect(ofType(sent, 'tweak')).toEqual([tweak('layout', 'list'), tweak('auto', false)]);
  const scroll = sent.findIndex((data) => data.type === 'scroll-to');
  expect(sent[scroll]).toEqual({ hive: 'design', type: 'scroll-to', id: 'D6' });
  expect(anchored(sent.slice(0, scroll))).toEqual(['D6']);
});

test('a comment pinned in natural reopens in natural (#341)', async () => {
  const user = userEvent.setup();
  showCommentsPanel(true);
  await pane();
  fromBridge({ type: 'tweaks', schema: BLOCK });
  await user.click(screen.getByText('on mobile'));
  expect(screen.getByRole('radio', { name: 'mobile' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByText('on the default'));
  expect(screen.getByRole('radio', { name: 'natural' })).toHaveAttribute('aria-checked', 'true');
});

test('a pointer-down, a typed value and a drag inside the open more… panel leave it open; a pointer-down outside closes it (#342)', async () => {
  const user = userEvent.setup();
  await pane();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80); // every control 80px in a 200px row: they overflow
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  fromBridge({ type: 'tweaks', schema: { ...BLOCK, title: { type: 'text', default: 'Flow' } } });
  await user.click(screen.getByRole('button', { name: 'mais…' }));
  const panel = (): HTMLElement => screen.getByRole('dialog', { name: 'tweaks' });
  const title = screen.getByRole('textbox', { name: 'title' });
  await user.click(title);
  await user.type(title, 's{Enter}');
  await user.click(screen.getByRole('switch', { name: 'auto' }));
  await user.pointer([{ keys: '[MouseLeft>]', target: screen.getByRole('heading', { name: 'tweaks' }) }, { coords: { x: 30, y: 30 } }, { keys: '[/MouseLeft]' }]);
  expect(panel()).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'title' })).toHaveValue('Flows');
  await user.click(document.body);
  expect(screen.queryByRole('dialog', { name: 'tweaks' })).toBeNull();
});
