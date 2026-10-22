import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ViewRail, type ViewRailProps } from '@/components/ViewRail';
import { setLanguage } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';

const MARK = 'shadow-[inset_2px_0_0_var(--foreground)]';
const props = (overrides: Partial<ViewRailProps> = {}): ViewRailProps => ({ center: 'activities', onView: vi.fn(), hasWaiting: false, onOpenShortcuts: vi.fn(), onOpenSettings: vi.fn(), ...overrides });
const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'views' });
const buttons = (): HTMLButtonElement[] => within(rail()).getAllByRole('button');
const button = (name: string): HTMLElement => within(rail()).getByRole('button', { name });

beforeEach(() => setLanguage('pt'));
afterEach(() => setShortcuts({}));

test('activities, flow and monitor at the top, a spacer, then the shortcut map and Settings at the bottom; no feedback button (#220)', () => {
  render(<ViewRail {...props()} />);
  expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['atividades', 'fluxo', 'plugins', 'benchmark', 'monitor · em breve', 'mapa de atalhos', 'configurações']);
  expect(button('monitor · em breve').nextElementSibling?.tagName).toBe('DIV'); // the spacer that pushes the last two down
});

test('the shown view\'s button is the current page with the inset marker, the other muted; switching center moves both (#220)', () => {
  const { rerender } = render(<ViewRail {...props()} />);
  const activities = button('atividades');
  const flow = button('fluxo');
  expect(activities).toHaveAttribute('aria-current', 'page');
  expect(activities).toHaveClass(MARK, 'text-foreground');
  expect(flow).not.toHaveAttribute('aria-current');
  expect(flow).not.toHaveClass(MARK);
  expect(flow).toHaveClass('text-muted-foreground');
  rerender(<ViewRail {...props({ center: 'automation' })} />);
  expect(flow).toHaveAttribute('aria-current', 'page');
  expect(flow).toHaveClass(MARK);
  expect(activities).not.toHaveAttribute('aria-current');
  expect(activities).not.toHaveClass(MARK);
});

test('a click on activities or flow calls onView with its tab (#220)', async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  render(<ViewRail {...props({ onView })} />);
  await user.click(button('fluxo'));
  await user.click(button('atividades'));
  expect(onView.mock.calls).toEqual([['automation'], ['activities']]);
});

test('monitor is disabled, titled as coming soon in Portuguese and in English, and a click calls nothing (#220)', async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  const onOpenShortcuts = vi.fn();
  const onOpenSettings = vi.fn();
  const all = props({ onView, onOpenShortcuts, onOpenSettings });
  const { rerender } = render(<ViewRail {...all} />);
  const monitor = button('monitor · em breve');
  expect(monitor).toBeDisabled();
  expect(monitor).toHaveAttribute('title', 'monitor · em breve');
  expect(monitor).not.toHaveAttribute('aria-current');
  await user.click(monitor);
  expect(onView).not.toHaveBeenCalled();
  expect(onOpenShortcuts).not.toHaveBeenCalled();
  expect(onOpenSettings).not.toHaveBeenCalled();
  setLanguage('en');
  rerender(<ViewRail {...all} />);
  expect(button('monitor · soon')).toHaveAttribute('title', 'monitor · soon');
});

test('the activities button carries the waiting dot with hasWaiting, and none without (#220)', () => {
  const { rerender } = render(<ViewRail {...props()} />);
  expect(rail().querySelector('[data-waiting-dot]')).toBeNull();
  rerender(<ViewRail {...props({ hasWaiting: true })} />);
  expect(rail().querySelectorAll('[data-waiting-dot]')).toHaveLength(1);
  expect(button('atividades').querySelector('[data-waiting-dot]')).toHaveClass('bg-waiting', 'size-1.5', 'ring-background');
});

test('the keyboard and settings buttons call their openers; each title is the name and its key, an unbound key the name alone (#220)', async () => {
  const user = userEvent.setup();
  const onOpenShortcuts = vi.fn();
  const onOpenSettings = vi.fn();
  const { rerender } = render(<ViewRail {...props({ onOpenShortcuts, onOpenSettings })} />);
  // jsdom runs as off macOS: CmdOrCtrl reads Ctrl
  expect(buttons().map((b) => b.title)).toEqual(['atividades Ctrl+1', 'fluxo Ctrl+2', 'plugins Ctrl+3', 'benchmark Ctrl+4', 'monitor · em breve', 'mapa de atalhos Ctrl+/', 'configurações Ctrl+,']);
  await user.click(button('mapa de atalhos'));
  await user.click(button('configurações'));
  expect(onOpenShortcuts).toHaveBeenCalledOnce();
  expect(onOpenSettings).toHaveBeenCalledOnce();
  setShortcuts({ viewActivities: null, shortcutMap: 'CmdOrCtrl+K' }); // a key turned off, a key rebound
  rerender(<ViewRail {...props({ onOpenShortcuts, onOpenSettings })} />);
  expect(button('atividades')).toHaveAttribute('title', 'atividades');
  expect(button('mapa de atalhos')).toHaveAttribute('title', 'mapa de atalhos Ctrl+K');
});

test('without an opener its button does not render (#220)', () => {
  render(<ViewRail center="activities" onView={vi.fn()} hasWaiting={false} />);
  expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['atividades', 'fluxo', 'plugins', 'benchmark', 'monitor · em breve']);
});
