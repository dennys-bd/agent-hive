import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { type DockPanel, DockGroup } from '@/components/DockGroup';
import { setLanguage } from '@/i18n';
import type { PanelId, Side } from '@/lib/dock-layout';

// The divider's pointer math is not under test here, its keys are: nothing to measure
const NOWHERE = { current: null };
const panelOf = (id: PanelId, title: string, extra: Partial<DockPanel> = {}): DockPanel => ({ id, title, body: <p>{`corpo ${title}`}</p>, ...extra });
const TWO = (): DockPanel[] => [
  panelOf('automation', 'Automação', { actions: <button type="button">mais</button> }),
  panelOf('detail', 'Detalhes', { actions: <button type="button">outra</button> }),
];
const group = (): HTMLElement => document.querySelector<HTMLElement>('[data-dock]')!;

// The group as the frame drives it: the active tab lives outside, and a tab's click sets it
function Group({ side = 'right', panels, initial, open = true, onMove = vi.fn(), onResize = vi.fn(), onClose = vi.fn() }: {
  side?: Side; panels: DockPanel[]; initial?: PanelId; open?: boolean; onMove?: (id: PanelId, side: Side) => void; onResize?: (size: number) => void; onClose?: () => void;
}) {
  const [active, setActive] = useState<PanelId | undefined>(initial);
  return (
    <DockGroup
      side={side} size={30} panels={panels} active={active} open={open} measure={NOWHERE}
      onActivate={setActive} onMove={onMove} onResize={onResize} onClose={onClose}
    />
  );
}

beforeEach(() => setLanguage('pt'));

test('one tab per panel in a tablist, the active one aria-selected, then only its own actions and the panel\'s X, which no tab carries (#342, #452)', () => {
  render(<Group panels={TWO()} initial="automation" />);
  expect(screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Automação', 'true'], ['Detalhes', 'false']]);
  expect(screen.getByRole('tablist')).toContainElement(screen.getByRole('tab', { name: 'Automação' }));
  const header = screen.getByRole('tablist').parentElement as HTMLElement;
  expect(Array.from(header.querySelectorAll('button')).map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Automação', 'Detalhes', 'mais', 'Fechar painel']);
  expect(screen.getAllByRole('button', { name: /^Fechar/ })).toHaveLength(1);
  expect(screen.getByText('corpo Automação')).toBeVisible();
  expect(screen.getByText('corpo Detalhes')).not.toBeVisible();
});

// Ahead of the userEvent.click tests below (#377): a plain userEvent.click anywhere in a document that also holds a mounted ContextMenu
// exhausts Radix's module-scoped DismissableLayer state under jsdom, so a later fireEvent.contextMenu here would never open.
test('right-clicking a tab\'s title offers the other side, and picking it calls onMove with that panel and side (#342)', async () => {
  const onMove = vi.fn();
  render(<Group side="right" panels={TWO()} initial="automation" onMove={onMove} />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Detalhes' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Mover para a esquerda']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para a esquerda' }));
  expect(onMove).toHaveBeenCalledWith('detail', 'left');
});

test('clicking a tab activates it; the body it hides stays mounted, collapsed, never remounted (#342)', async () => {
  const user = userEvent.setup();
  const mounts = vi.fn();
  function Probe() {
    useEffect(() => mounts(), []);
    return <p>sonda</p>;
  }
  const [automation, detail] = TWO();
  render(<Group panels={[{ ...automation, body: <Probe /> }, detail]} initial="automation" />);
  await user.click(screen.getByRole('tab', { name: 'Detalhes' }));
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('corpo Detalhes')).toBeVisible();
  expect(screen.getByRole('button', { name: 'outra' })).toBeInTheDocument();
  expect(screen.getByText('sonda')).not.toBeVisible();
  expect(mounts).toHaveBeenCalledTimes(1);
});

test('the panel\'s X calls onClose once (#452)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Group panels={TWO()} initial="automation" onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Fechar painel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('the divider sits on the inner edge, oriented and stepped for its side, bounded 15..70; the group takes its size as a flex basis (#342)', async () => {
  const user = userEvent.setup();
  const cases = [
    { side: 'left', label: 'redimensionar o painel da esquerda', edge: 'last', axis: 'vertical', key: '{ArrowRight}', max: '70' },
    { side: 'right', label: 'redimensionar o painel da direita', edge: 'first', axis: 'vertical', key: '{ArrowLeft}', max: '70' },
  ] as const;
  for (const c of cases) {
    const onResize = vi.fn();
    const { unmount } = render(<Group side={c.side} panels={[panelOf('detail', 'Detalhes')]} initial="detail" onResize={onResize} />);
    const separator = screen.getByRole('separator', { name: c.label });
    expect(c.edge === 'last' ? group().lastElementChild : group().firstElementChild).toBe(separator);
    expect(separator).toHaveAttribute('aria-orientation', c.axis);
    expect([separator.getAttribute('aria-valuemin'), separator.getAttribute('aria-valuemax')]).toEqual(['15', c.max]);
    expect(group()).toHaveStyle({ flexBasis: '30%' });
    separator.focus();
    await user.keyboard(c.key);
    expect(onResize).toHaveBeenCalledWith(35); // the raw step: the dock state clamps
    unmount();
  }
});

test('a closed group has no header, no X and no divider and collapses, every body still mounted and never remounted when it opens again (#342, #452)', () => {
  const mounts = vi.fn();
  function Probe() {
    useEffect(() => mounts(), []);
    return <p>sonda</p>;
  }
  const [automation, detail] = TWO();
  const panels = [{ ...automation, body: <Probe /> }, detail];
  const { rerender } = render(<Group panels={panels} initial="automation" open={false} />);
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Fechar painel' })).not.toBeInTheDocument();
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  expect(screen.getByText('sonda')).not.toBeVisible();
  expect(screen.getByText('corpo Detalhes')).not.toBeVisible();
  expect(group()).toHaveStyle({ opacity: '0' });
  rerender(<Group panels={panels} initial="automation" open />);
  expect(screen.getByText('sonda')).toBeVisible();
  expect(mounts).toHaveBeenCalledTimes(1);
});

test('a panel alone in its group with its own header gets no group header: its body draws one (redesign 07); beside another panel the tabs are back', () => {
  const own = panelOf('detail', 'Detalhes', { ownHeader: true });
  const { rerender } = render(<Group panels={[own]} initial="detail" />);
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Fechar painel' })).not.toBeInTheDocument();
  expect(screen.getByText('corpo Detalhes')).toBeVisible();
  rerender(<Group panels={[panelOf('automation', 'Automação'), own]} initial="detail" />);
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Automação', 'Detalhes']);
});
