import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { tIn } from '@/i18n';
import type { CenterLayout } from '@/lib/center-layout';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const PATH = 'docs/arch.drawio';
// The stage's run, then a diagram, shown (#956)
const DIAGRAM: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'diagram', path: PATH }], active: 1 }, focused: 'g1' };
const LABEL = '#1 Task 1 · Diagrama arch.drawio';
const frame = (): HTMLElement => screen.getByTitle('arch.drawio');
const layerOf = (element: HTMLElement): HTMLElement | null => element.closest('[data-design-layer]');

beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/file-version') ? jsonResponse({ version: 'v1' }) : jsonResponse({ path: PATH, text: '<mxfile/>', version: 'v1' }))));
  seed(DIAGRAM);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('a stored diagram tab reads its file\'s name with its path as the tooltip, has no pane header, and its pane frames draw.io from the design layer (#956)', () => {
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'arch.drawio']]);
  expect(screen.getByRole('tab', { name: 'arch.drawio' })).toHaveAttribute('title', PATH);
  expect(document.querySelector('[data-pane-header]')).toBeNull();
  expect(screen.getByRole('region', { name: LABEL })).toBeInTheDocument();
  expect(frame().getAttribute('src')).toMatch(/^\/drawio\/index\.html\?/);
  expect(layerOf(frame())).not.toHaveAttribute('inert');
});

test('a tab switch keeps the same draw.io frame, hidden and inert behind the run, and shows it again (#956)', () => {
  render(<Center runs={[STAGE]} />);
  const shown = frame();
  fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));
  expect(frame()).toBe(shown);
  expect(layerOf(shown)).toHaveAttribute('inert');
  expect(layerOf(shown)?.style.visibility).toBe('hidden');
  fireEvent.click(screen.getByRole('tab', { name: 'arch.drawio' }));
  expect(frame()).toBe(shown);
  expect(layerOf(shown)).not.toHaveAttribute('inert');
});

test('the diagram tab\'s accessible label reads as the spec writes it, in both languages (#956)', () => {
  expect([tIn('en', 'diagram.tab', { label: 'L', name: 'a.drawio' }), tIn('pt', 'diagram.tab', { label: 'L', name: 'a.drawio' })]).toEqual(['L · Diagram a.drawio', 'L · Diagrama a.drawio']);
});
