import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { t } from '@/i18n';
import type { CenterLayout } from '@/lib/center-layout';
import { resetViewState } from '@/lib/view-state';
import { jsonResponse } from '../fakes';
import { REVIEW } from './design-review';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// The stage's run, then a Hive design, shown (#109)
const DESIGN: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'design', path: 'design/Landing.hv.html' }], active: 1 }, focused: 'g1' };
// The same design behind the run, the run shown (#533)
const BEHIND: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'design', path: 'design/Landing.hv.html' }], active: 0 }, focused: 'g1' };
const LABEL = '#1 Task 1 · Design Landing.hv.html';
const versionReads = (): number => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('file-version')).length;
const layerOf = (frame: HTMLElement): HTMLElement | null => frame.closest('[data-design-layer]');

// g1 [the run] beside g2 [the design], g1 focused
const TWO_GROUPS: CenterLayout = {
  root: {
    kind: 'split', axis: 'row', sizes: [50, 50], children: [
      { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 },
      { kind: 'group', id: 'g2', tabs: [{ kind: 'design', path: 'design/Landing.hv.html' }], active: 0 },
    ],
  },
  focused: 'g1',
};
const groupSection = (id: string): HTMLElement | null => document.querySelector(`section[data-center-group="${id}"]`);

beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' }))));
  seed(DESIGN);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('a stored design tab reads its file\'s name with its path as the tooltip, has no pane header, and renders the minted frame (#109)', async () => {
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'Landing.hv.html']]);
  expect(screen.getByRole('tab', { name: 'Landing.hv.html' })).toHaveAttribute('title', 'design/Landing.hv.html');
  expect(document.querySelector('[data-pane-header]')).toBeNull();
  expect(screen.getByRole('region', { name: '#1 Task 1 · Design Landing.hv.html' })).toBeInTheDocument();
  expect(await screen.findByTitle('Landing.hv.html')).toHaveAttribute('src', '/design-frame/tok/Landing.hv.html');
});

test('the design tab shows its open count in a pill before its ×, beside the tab\'s name (#113)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/tasks/I1/review') return jsonResponse(REVIEW);
    return url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' });
  }));
  render(<Center runs={[STAGE]} />);
  const tab = document.querySelector<HTMLElement>('[data-tab-key="design:design/Landing.hv.html"]');
  expect(await within(tab as HTMLElement).findByText('4')).toHaveClass('bg-accent');
  expect(strips()).toEqual([['Claude', 'Landing.hv.html']]); // the pill sits outside the tab\'s name
});

test('a local activity\'s design tab shows its open count too, read from the workspace\'s review (#345)', async () => {
  resetViewState({ centerLayouts: { 'local/hive': { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'design', path: 'design/Landing.hv.html' }], active: 0 }, focused: 'g1' } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/workspaces/hive/review') return jsonResponse(REVIEW);
    return url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' });
  }));
  render(<Center runs={[]} local="hive" />);
  const tab = document.querySelector<HTMLElement>('[data-tab-key="design:design/Landing.hv.html"]');
  expect(await within(tab as HTMLElement).findByText('4')).toHaveClass('bg-accent');
});

test('a design tab behind another tab keeps its frame in the design layer, hidden, inert and unpolled; picked, the same frame shows and polls (#533)', async () => {
  seed(BEHIND);
  render(<Center runs={[STAGE]} />);
  const frame = await screen.findByTitle('Landing.hv.html');
  expect(layerOf(frame)).toHaveAttribute('inert');
  expect(layerOf(frame)?.style.visibility).toBe('hidden');
  expect(versionReads()).toBe(0);
  fireEvent.click(screen.getByRole('tab', { name: 'Landing.hv.html' }));
  expect(screen.getByTitle('Landing.hv.html')).toBe(frame);
  expect(layerOf(frame)).not.toHaveAttribute('inert');
  expect(screen.getByRole('region', { name: LABEL })).toBeInTheDocument();
  await waitFor(() => expect(versionReads()).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));
  expect(screen.getByTitle('Landing.hv.html')).toBe(frame);
  expect(layerOf(frame)).toHaveAttribute('inert');
});

test('closing the design tab removes its pane and its frame (#533)', async () => {
  render(<Center runs={[STAGE]} />);
  await screen.findByTitle('Landing.hv.html');
  fireEvent.click(screen.getByRole('button', { name: `${t('center.close')} Landing.hv.html` }));
  expect(strips()).toEqual([['Claude']]);
  expect(screen.queryByTitle('Landing.hv.html')).toBeNull();
  expect(document.querySelector('[data-design-layer]')).toBeNull();
});

test('a pointer down in a shown design pane focuses its group, as one in the group\'s own element does (#533)', async () => {
  seed(TWO_GROUPS);
  render(<Center runs={[STAGE]} />);
  await screen.findByTitle('Landing.hv.html');
  expect(groupSection('g2')).not.toHaveAttribute('data-focused');
  fireEvent.pointerDown(screen.getByRole('region', { name: LABEL }));
  expect(groupSection('g2')).toHaveAttribute('data-focused', 'true');
});

test('⌘W with the keyboard focus inside a shown design pane closes its group\'s design tab, not the focused group\'s tab (#533)', async () => {
  let closeKey: (() => void) | undefined;
  vi.stubGlobal('hive', { onCloseKey: (callback: () => void) => { closeKey = callback; return () => undefined; } });
  seed(TWO_GROUPS);
  render(<Center runs={[STAGE]} />);
  await screen.findByTitle('Landing.hv.html');
  act(() => screen.getByRole('region', { name: LABEL }).focus());
  act(() => closeKey?.());
  expect(strips()).toEqual([['Claude']]);
  expect(screen.queryByTitle('Landing.hv.html')).toBeNull();
});
