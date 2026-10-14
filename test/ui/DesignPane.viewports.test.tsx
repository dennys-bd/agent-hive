import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import { FRAME_NAME, fromBridge, mintFrame, PATH } from './design-review';
import { activityOf, fakeHive, withSessions } from './diff-harness';

// The natural viewport and the opt-in switch (#341)
const CANVAS_PX = 672; // the fit is (672 − 32) / the frame's width
const frame = (): HTMLElement => screen.getByTitle(FRAME_NAME);
const percent = (): string => screen.getByTitle('⌘0 ajusta à tela').textContent ?? '';
const size = (natural: unknown, extra: Record<string, unknown> = {}): void => fromBridge({ type: 'size', height: 600, natural, ...extra });
const declare = (schema: Record<string, unknown>): void => fromBridge({ type: 'tweaks', schema });
// The switch's items, none while it is not rendered
function switchItems(): string[] {
  const group = screen.queryByRole('radiogroup', { name: 'viewport' });
  return group === null ? [] : within(group).getAllByRole('radio').map((item) => item.textContent ?? '');
}

beforeEach(() => {
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  showCommentsPanel(false);
  mintFrame(fakeHive());
  // jsdom lays nothing out: the canvas alone gets a width, so the fit has something to measure
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return this.hasAttribute('data-design-canvas') ? CANVAS_PX : 0; });
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pane(): Promise<void> {
  render(<DesignPane activity={activityOf(withSessions())} path={PATH} label="#1 Task 1 · Design Landing.hv.html" active />);
  await screen.findByTitle(FRAME_NAME);
  await waitFor(() => expect(screen.getByRole('button', { name: 'comentários' })).toHaveTextContent('0'));
}

test('with no viewports the pane opens in natural with no switch; the frame takes the measured width held to 390–1280, and refits (#341)', async () => {
  await pane();
  expect([frame().getAttribute('width'), frame().getAttribute('height'), switchItems()]).toEqual(['1280', '800', []]); // before the first measure
  declare({ density: { options: ['compact', 'roomy'], default: 'compact' } });
  expect(switchItems()).toEqual([]);
  size(880);
  expect([frame().getAttribute('width'), frame().getAttribute('height'), percent()]).toEqual(['880', '600', '72%']);
  size(16_900); // a fluid text page
  expect(frame()).toHaveAttribute('width', '1280');
  size(0); // an empty page
  expect([frame().getAttribute('width'), percent()]).toEqual(['390', '100%']);
  size('wide', { width: 1440 }); // a bad natural keeps the last; an overflow width is a fixed viewport's, not natural's
  expect(frame()).toHaveAttribute('width', '390');
});

test('a block declaring desktop and mobile shows natural, desktop and mobile; they render at 1280 and 390, and natural keeps its measure (#341)', async () => {
  const user = userEvent.setup();
  await pane();
  size(880);
  declare({ viewports: ['desktop', 'mobile'] });
  expect(switchItems()).toEqual(['natural', 'desktop', 'mobile']);
  expect(screen.getByRole('radio', { name: 'natural' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('radio', { name: 'desktop' }));
  expect(frame()).toHaveAttribute('width', '1280');
  await user.click(screen.getByRole('radio', { name: 'mobile' }));
  expect(frame()).toHaveAttribute('width', '390');
  await user.click(screen.getByRole('radio', { name: 'natural' }));
  expect(frame()).toHaveAttribute('width', '880');
});

test('a viewport the screen no longer declares stays in the switch while it is the current one (#341)', async () => {
  const user = userEvent.setup();
  await pane();
  declare({ viewports: ['tablet', 'mobile'] });
  await user.click(screen.getByRole('radio', { name: 'mobile' }));
  declare({ viewports: ['tablet'] });
  expect(switchItems()).toEqual(['natural', 'tablet', 'mobile']);
  declare({});
  expect(switchItems()).toEqual(['natural', 'mobile']);
  await user.click(screen.getByRole('radio', { name: 'natural' }));
  expect(switchItems()).toEqual([]);
});

test('viewports is not a tweak: alone it shows no tweaks row, beside a tweak only the tweak has a control, and an invalid one makes the block invalid (#341)', async () => {
  await pane();
  declare({ viewports: ['mobile'] });
  expect(screen.queryByRole('toolbar', { name: 'tweaks' })).toBeNull();
  declare({ viewports: ['mobile'], density: { options: ['compact', 'roomy'], default: 'compact' } });
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  expect(within(row).getByRole('combobox', { name: 'density' })).toBeInTheDocument();
  expect(within(row).queryByText('viewports')).toBeNull();
  declare({ viewports: ['watch'] });
  expect(screen.getByRole('toolbar', { name: 'tweaks' })).toHaveTextContent('o bloco hv-tweaks é inválido');
});
