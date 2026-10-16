import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Header } from '@/components/Header';
import { FullScreenContext } from '@/hooks/use-full-screen';
import type { HeaderShell } from '@/hooks/use-header-shell';
import { setLanguage } from '@/i18n';
import { onPanelKey, type ViewLayout } from '@/lib/dock-layout';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { EffectiveLimits, Signal, State } from '../../src/types';
import { activityIdOf } from '../fixtures/work';
import { stateOf } from './search-fixtures';

const LAYOUT: ViewLayout = { docks: { automation: 'left', activities: 'left', plugins: 'left', detail: 'right' }, sizes: { left: 30, right: 30 }, open: { left: true, right: true } };
const LEFT_CLOSED: ViewLayout = { ...LAYOUT, open: { left: false, right: true } };
const shellOf = (extra: Partial<HeaderShell> = {}): HeaderShell => ({
  center: 'activities', layout: LAYOUT, rightShown: true, canOpenRight: true,
  panes: { active: 'files', enabled: { files: true, details: true }, pick: vi.fn() }, ...extra,
});
// One worker the cap counts, against a cap of 5
const STATE: State = { ...stateOf([]), maxConcurrent: 5, workers: [{ id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' }] };
const limits = (signal: Signal, maxWorkers?: number): EffectiveLimits => ({
  signal, ...(maxWorkers === undefined ? {} : { maxWorkers }), floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {},
});
const header = (shell: HeaderShell = shellOf(), effective: EffectiveLimits = limits('green'), isFullScreen = false) => (
  <FullScreenContext.Provider value={isFullScreen}><Header shell={shell} state={STATE} effective={effective} /></FullScreenContext.Provider>
);
const banner = (): HTMLElement => screen.getByRole('banner');
const column = (name: 'left' | 'center' | 'right'): HTMLElement | null => banner().querySelector<HTMLElement>(`[data-header-column="${name}"]`);
const brand = (): HTMLElement => screen.getByRole('button', { name: 'hive · workers 1/5' });
const mark = (): HTMLElement => screen.getByRole('button', { name: 'hive' }); // the closed side's ⬢ (#295)

beforeEach(() => setLanguage('pt'));
afterEach(() => setShortcuts({}));

test('the brand reads hive · workers {active}/{max} in the left column, the max the effective cap when a rule sets one (#221)', () => {
  const { rerender } = render(header());
  expect(column('left')).toContainElement(brand());
  rerender(header(shellOf(), limits('green', 2)));
  expect(screen.getByRole('button', { name: 'hive · workers 1/2' })).toBeInTheDocument();
});

test('left side open, in a window and in full screen: the left column, bordered, holds the brand and panel-left with the window inset; the center starts bare (#221, #295)', () => {
  for (const isFullScreen of [false, true]) {
    const { unmount } = render(header(shellOf(), limits('green'), isFullScreen));
    const left = column('left') as HTMLElement;
    expect(left).toHaveClass('border-r', 'pl-(--window-inset)'); // index.css: 84px in a window, 12px under data-fullscreen
    expect(left).toContainElement(brand());
    expect(within(left).getByRole('button', { name: 'recolher lateral' })).toBeInTheDocument();
    expect(within(column('center') as HTMLElement).queryAllByRole('button')).toEqual([]);
    unmount();
  }
});

test('left side closed in a window: a 92px block holding the window buttons\' space and a gap, with no border; the center starts with panel-left, a divider and the ⬢, and hive · workers leaves the header (#295)', () => {
  render(header(shellOf({ layout: LEFT_CLOSED })));
  const left = column('left') as HTMLElement;
  expect(left.style.width).toBe('92px');
  expect(left).not.toHaveClass('border-r');
  expect(left).toBeEmptyDOMElement();
  const center = column('center') as HTMLElement;
  const [open, divider, hex] = Array.from(center.children);
  expect(open).toBe(screen.getByRole('button', { name: 'abrir lateral' }));
  expect(divider).toHaveClass('w-px', 'self-stretch', 'bg-border'); // the header's full height
  expect(hex).toBe(mark());
  expect(center).not.toHaveClass('border-l');
  expect(within(banner()).queryByText(/workers/)).not.toBeInTheDocument();
});

test('left side closed in full screen: a left column the rail\'s width holds panel-left over the rail\'s icons, its border on the rail\'s; the center leads with the ⬢ (#295)', () => {
  render(header(shellOf({ layout: LEFT_CLOSED }), limits('green'), true));
  const left = column('left') as HTMLElement;
  expect(left.style.width).toBe('44px');
  expect(left).toHaveClass('border-r', 'justify-center');
  expect(left.firstElementChild).toBe(screen.getByRole('button', { name: 'abrir lateral' }));
  expect(column('center')).toHaveClass('pl-3');
  expect(column('center')?.firstElementChild).toBe(mark());
});

test('hovering the open brand opens the popover too, and the pointer leaving closes it (#295)', async () => {
  const user = userEvent.setup();
  render(header());
  await user.hover(brand());
  const popover = await screen.findByRole('dialog', { name: 'hive' });
  expect(within(popover).getByText('workers 1/5')).toBeInTheDocument();
  await user.unhover(brand());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('the brand\'s title names the signal and what it holds back, a green holding nothing back has no middle part, and no "click to change"; the closed ⬢ carries the same; the mark takes the signal\'s colour (#221, #533, #295)', () => {
  const { rerender } = render(header(shellOf(), limits('yellow')));
  expect(brand()).toHaveAttribute('title', 'sinal yellow · tarefas novas só de árvore iniciada');
  expect(brand().querySelector('[data-signal]')?.getAttribute('class')).toMatch(/text-signal-yellow/);
  rerender(header(shellOf(), limits('green')));
  expect(brand()).toHaveAttribute('title', 'sinal green');
  rerender(header(shellOf({ layout: LEFT_CLOSED }), limits('yellow')));
  expect(mark()).toHaveAttribute('title', 'sinal yellow · tarefas novas só de árvore iniciada');
});

test('a click on the open brand opens the signal popover: hive and workers {active}/{max}, a separator, then the signal toggle, a fired rule\'s floor locking the looser items (#221, #295)', async () => {
  const user = userEvent.setup();
  render(header(shellOf(), { ...limits('yellow'), floor: { signal: 'yellow' } }));
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  await user.click(brand());
  const popover = await screen.findByRole('dialog');
  expect(within(popover).getByText('hive')).toBeInTheDocument();
  expect(within(popover).getByText('workers 1/5')).toBeInTheDocument();
  expect(within(popover).getByRole('separator')).toBeInTheDocument();
  expect(within(popover).getAllByRole('radio').map((item) => [item.textContent, (item as HTMLButtonElement).disabled])).toEqual([['green', true], ['yellow', false], ['red', false]]);
});

test('with the left side closed, hovering, focusing or clicking the ⬢ opens the same popover; the pointer leaving the ⬢ and the popover closes it, as Escape does (#295)', async () => {
  const user = userEvent.setup();
  render(header(shellOf({ layout: LEFT_CLOSED })));
  await user.hover(mark());
  const popover = await screen.findByRole('dialog');
  expect(within(popover).getByText('workers 1/5')).toBeInTheDocument();
  expect(within(popover).getAllByRole('radio')).toHaveLength(3);
  expect(document.activeElement).not.toBe(mark()); // a hover never moves the focus
  await user.hover(popover); // crossing the gap from the ⬢ keeps it open
  await user.unhover(popover);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  act(() => mark().focus());
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); // the focus handed back to the ⬢ does not reopen it
  await user.click(mark());
  expect(await screen.findByRole('dialog', { name: 'hive' })).toBeInTheDocument();
});

test('a popover the keyboard or a click opened stays when the pointer crosses the ⬢ and leaves (#295)', async () => {
  const user = userEvent.setup();
  render(header(shellOf({ layout: LEFT_CLOSED })));
  act(() => mark().focus());
  const popover = await screen.findByRole('dialog');
  await user.hover(mark());
  await user.unhover(mark());
  await new Promise((resolve) => setTimeout(resolve, 300)); // past the hover close's delay
  expect(popover).toBeInTheDocument();
});

test('the mark is one size in every state: the open brand, the closed ⬢ and the popover\'s first row (#295)', async () => {
  const user = userEvent.setup();
  const classes = (): string[] => Array.from(document.querySelectorAll('svg[data-signal]'), (svg) => svg.getAttribute('class') ?? '');
  const { unmount } = render(header());
  await user.click(brand());
  await screen.findByRole('dialog');
  const open = classes();
  unmount();
  render(header(shellOf({ layout: LEFT_CLOSED }), limits('green'), true));
  await user.hover(mark());
  await screen.findByRole('dialog');
  const seen = [...open, ...classes()];
  expect(seen).toHaveLength(4);
  expect(new Set(seen)).toEqual(new Set(['size-3 shrink-0 text-signal-green']));
});

test('panel-left runs toggleLeft as the key does; its name follows the left side, its title adds the key, the name alone when unbound (#221)', async () => {
  const user = userEvent.setup();
  const toggle = vi.fn();
  const off = onPanelKey(toggle);
  const { rerender } = render(header());
  const collapse = within(column('left') as HTMLElement).getByRole('button', { name: 'recolher lateral' });
  expect(collapse).toHaveAttribute('title', 'recolher lateral Ctrl+Shift+B'); // jsdom runs as off macOS
  await user.click(collapse);
  expect(toggle).toHaveBeenCalledWith('left');
  rerender(header(shellOf({ layout: LEFT_CLOSED })));
  expect(screen.getByRole('button', { name: 'abrir lateral' })).toHaveAttribute('title', 'abrir lateral Ctrl+Shift+B');
  setShortcuts({ toggleLeft: null });
  rerender(header(shellOf({ layout: LEFT_CLOSED })));
  expect(screen.getByRole('button', { name: 'abrir lateral' })).toHaveAttribute('title', 'abrir lateral');
  off();
});

test('the center column holds the activity\'s bar; without one, only the empty slot the flow\'s bar portals into (#221, #295)', () => {
  const { rerender } = render(header(shellOf({ bar: <p>the bar</p> })));
  expect(column('center')).toContainElement(screen.getByText('the bar'));
  expect(column('center')?.querySelector('[data-header-slot]')).toBeNull();
  rerender(header());
  expect(column('center')?.children).toHaveLength(1);
  expect(column('center')?.querySelector('[data-header-slot]')).toBeEmptyDOMElement();
});

test('the right column always shows arquivos then detalhes, a pane the side cannot show disabled, the active one pressed and named at the end; a click picks the pane, active or not (#221)', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  const { rerender } = render(header(shellOf({ panes: { active: 'files', enabled: { files: true, details: false }, pick } })));
  const right = column('right') as HTMLElement;
  expect(within(right).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['arquivos', 'detalhes']);
  expect(within(right).getByRole('button', { name: 'detalhes' })).toBeDisabled();
  expect(within(right).getByRole('button', { name: 'arquivos' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(right).getByRole('button', { name: 'arquivos' })).toHaveClass('bg-accent', 'text-foreground');
  expect(right.lastElementChild).toHaveTextContent('arquivos');
  await user.click(within(right).getByRole('button', { name: 'arquivos' })); // the active one
  rerender(header(shellOf({ panes: { active: 'details', enabled: { files: true, details: true }, pick } })));
  expect(within(column('right') as HTMLElement).getByRole('button', { name: 'arquivos' })).toHaveAttribute('aria-pressed', 'false');
  await user.click(within(column('right') as HTMLElement).getByRole('button', { name: 'arquivos' })); // an inactive one
  expect(pick.mock.calls).toEqual([['files'], ['files']]);
  expect(screen.queryByRole('button', { name: 'abrir lateral direita' })).not.toBeInTheDocument();
});

test('with the right column gone, panel-right runs toggleRight as the key does, disabled where nothing can open (#221)', async () => {
  const user = userEvent.setup();
  const toggle = vi.fn();
  const off = onPanelKey(toggle);
  const { rerender } = render(header(shellOf({ rightShown: false })));
  expect(column('right')).toBeNull();
  const open = screen.getByRole('button', { name: 'abrir lateral direita' });
  expect(open).toHaveAttribute('title', 'abrir lateral direita Ctrl+Alt+Shift+B');
  await user.click(open);
  expect(toggle).toHaveBeenCalledWith('right');
  rerender(header(shellOf({ rightShown: false, canOpenRight: false })));
  expect(screen.getByRole('button', { name: 'abrir lateral direita' })).toBeDisabled();
  off();
});

test('no view switch and no usage; the header drags the window and each of its own controls opts out (#221, #223)', () => {
  const { container } = render(header());
  expect(screen.queryAllByRole('radio')).toEqual([]);
  expect(container.querySelectorAll('[data-slot="progress"]')).toHaveLength(0);
  expect(container.querySelector('[data-icon]')).toBeNull();
  expect(banner()).toHaveClass('[-webkit-app-region:drag]');
  const buttons = within(banner()).getAllByRole('button');
  expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['hive · workers 1/5', 'recolher lateral', 'arquivos', 'detalhes']);
  for (const button of buttons) expect(button).toHaveClass('[-webkit-app-region:no-drag]');
  cleanup();
  render(header(shellOf({ layout: LEFT_CLOSED })));
  const closed = within(banner()).getAllByRole('button');
  expect(closed.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['abrir lateral', 'hive', 'arquivos', 'detalhes']);
  for (const button of closed) expect(button).toHaveClass('[-webkit-app-region:no-drag]');
});
