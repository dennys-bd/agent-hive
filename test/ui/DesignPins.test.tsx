import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { composerStyle, PIN_GAP, PIN_SIZE, pinStyle } from '@/components/DesignPins';
import { setLanguage } from '@/i18n';
import { FRAME_NAME, fromBridge, mintFrame, PATH, pinsAt, RECT, REVIEW, stubScrollIntoView, unstubScrollIntoView } from './design-review';
import { activityOf, fakeHive, type FakeHive, withSessions } from './diff-harness';

let hive: FakeHive;
beforeEach(() => {
  showCommentsPanel(true);
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  hive = fakeHive();
  hive.review = REVIEW;
  mintFrame(hive);
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  unstubScrollIntoView();
  vi.unstubAllGlobals();
});

// jsdom measures no canvas, so the fit never runs: the pane stays at 100 %
async function pane(): Promise<void> {
  render(<DesignPane activity={activityOf(withSessions())} path={PATH} label="#1 Task 1 · Design Landing.hv.html" active />);
  await screen.findByTitle(FRAME_NAME);
  await screen.findByText('a draft');
}
const pin = (n: number): HTMLElement | null => screen.queryByRole('button', { name: `comentário ${n}` });
const drawn = (): string[] => screen.queryAllByRole('button', { name: /^comentário \d+$/ }).map((b) => b.textContent ?? '');

test('pinStyle puts the drop\'s sharp corner 6 px above and left of the target\'s corner, at a size the zoom never changes; the composer keeps inside the box (#114)', () => {
  const full = pinStyle(RECT, 1);
  const half = pinStyle(RECT, 0.5);
  expect([full.left, full.top + full.height]).toEqual([RECT.x - PIN_GAP, RECT.y - PIN_GAP]);
  expect([half.left, half.top + half.height]).toEqual([RECT.x / 2 - PIN_GAP, RECT.y / 2 - PIN_GAP]);
  expect([full.width, full.height, half.width, half.height]).toEqual([PIN_SIZE, PIN_SIZE, PIN_SIZE, PIN_SIZE]);
  expect(composerStyle({ ...RECT, x: 1200 }, 1, 1280).left).toBe(1280 - 340);
  expect(composerStyle({ ...RECT, x: 0 }, 1, 1280).left).toBe(0);
});

test('a pins message draws one pin per non-null rect, numbered by its anchor\'s pin, in its state\'s colour; a null rect draws none (#114)', async () => {
  await pane();
  expect(drawn()).toEqual([]); // nothing answered since the load
  fromBridge({ type: 'pins', pins: [{ id: 'D5', rect: RECT }, { id: 'T4', rect: RECT }, { id: 'T2', rect: RECT }, { id: 'T3', rect: null }, { id: 'T6', rect: RECT }] });
  expect(drawn()).toEqual(['2', '4', '5']); // by pin; T3 removed, T6 resolved
  expect(pin(5)).toHaveStyle({ backgroundColor: '#e6e6e6', color: '#111418' }); // a draft: the dark design's ink
  expect(pin(4)).toHaveClass('bg-working', 'text-white');
  expect(pin(2)).toHaveClass('bg-waiting', 'text-[#111418]');
  expect(pin(2)).toHaveStyle({ left: `${RECT.x - PIN_GAP}px`, top: `${RECT.y - PIN_GAP - PIN_SIZE}px` });
});

test('resolved pins draw, as a ✓, only while the panel shows its resolved tab (#114)', async () => {
  const user = userEvent.setup();
  await pane();
  fromBridge(pinsAt(['T1', 'T4']));
  expect([pin(1), pin(4)?.textContent]).toEqual([null, '4']);
  await user.click(screen.getByRole('radio', { name: 'resolvidos · 2' }));
  expect(pin(1)).toHaveTextContent('✓');
  await user.click(screen.getByRole('button', { name: 'comentários' })); // the panel hidden
  expect(pin(1)).toBeNull();
});

test('a pin click selects its item and scrolls it into view; with the panel hidden it shows the panel, on the open tab (#114)', async () => {
  const user = userEvent.setup();
  const scrolled = stubScrollIntoView();
  await pane();
  await user.click(screen.getByRole('radio', { name: 'resolvidos · 2' }));
  await user.click(screen.getByRole('button', { name: 'comentários' }));
  expect(screen.queryByRole('complementary', { name: 'comentários' })).toBeNull();
  fromBridge(pinsAt(['T4']));
  await user.click(pin(4) as HTMLElement);
  expect(screen.getByRole('radio', { name: 'abertos · 4' })).toHaveAttribute('aria-checked', 'true');
  const item = screen.getByText('with the agent').closest('li');
  expect(item).toHaveAttribute('aria-current', 'true');
  expect(pin(4)).toHaveAttribute('aria-current', 'true');
  expect(scrolled.mock.contexts).toContain(item);
});
