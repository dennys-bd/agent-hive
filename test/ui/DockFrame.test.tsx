import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DockFrame } from '@/components/DockFrame';
import type { DockPanel } from '@/components/DockGroup';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT, type Side, sideOf, type ViewLayout } from '@/lib/dock-layout';

const PANELS: DockPanel[] = [
  { id: 'activities', title: 'Atividades', body: <p>corpo Atividades</p> },
  { id: 'detail', title: 'Detalhes', body: <p>corpo Detalhes</p> },
];
const FLAT = sideOf(DEFAULT_DOCK_LAYOUT, 'activities');
const group = (side: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-dock="${side}"]`);

function Frame({ layout, onClose = vi.fn() }: { layout: ViewLayout; onClose?: (side: Side) => void }) {
  return (
    <DockFrame
      layout={layout} shown={{ left: 'activities', right: 'detail' }} panels={PANELS}
      onActivate={vi.fn()} onResize={vi.fn()} onClose={onClose}
    >
      <main>fluxo</main>
    </DockFrame>
  );
}

beforeEach(() => setLanguage('pt'));

test('the frame is the left group, the center column and the right group, the side groups spanning its height, each holding the panels docked there (#342)', () => {
  render(<Frame layout={FLAT} />);
  const center = screen.getByRole('main').parentElement!;
  const frame = center.parentElement!;
  expect(Array.from(frame.children)).toEqual([group('left'), center, group('right')]);
  expect(group('left')).toContainElement(screen.getByText('corpo Atividades'));
  expect(group('right')).toContainElement(screen.getByText('corpo Detalhes'));
});

test('a side with no panel renders nothing, and there is no bottom group in the center column (#342)', () => {
  render(<Frame layout={{ ...FLAT, docks: { automation: 'left', activities: 'right', detail: 'right' } }} />);
  const center = screen.getByRole('main').parentElement!;
  expect(Array.from(center.children)).toEqual([screen.getByRole('main')]);
  expect(group('left')).toBeNull();
  expect(group('right')).toContainElement(screen.getByText('corpo Atividades'));
  expect(center.parentElement!.lastElementChild).toBe(group('right'));
});

test('each group gets its side\'s open flag, and its X closes that side (#452)', () => {
  const onClose = vi.fn();
  render(<Frame layout={{ ...FLAT, open: { left: true, right: false } }} onClose={onClose} />);
  expect(group('right')).toHaveStyle({ opacity: '0' });
  expect(within(group('left')!).getByRole('tab', { name: 'Atividades' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar painel' }));
  expect(onClose).toHaveBeenCalledWith('left');
});

test('the frame shrinks with the window instead of taking its content\'s width, so the center never runs under the right group (#295)', () => {
  render(<Frame layout={FLAT} />);
  const frame = screen.getByRole('main').parentElement!.parentElement!;
  expect(frame).toHaveClass('min-w-0', 'min-h-0', 'flex-1', 'flex-row');
});
