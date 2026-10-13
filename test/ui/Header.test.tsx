import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Header } from '@/components/Header';
import type { HeaderShell } from '@/hooks/use-header-shell';
import { setLanguage } from '@/i18n';
import { onPanelKey, type ViewLayout } from '@/lib/dock-layout';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { EffectiveLimits, Signal, State } from '../../src/types';
import { activityIdOf } from '../fixtures/work';
import { stateOf } from './search-fixtures';

const LAYOUT: ViewLayout = { docks: { automation: 'left', activities: 'left', detail: 'right' }, sizes: { left: 30, right: 30 }, open: { left: true, right: true } };
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
const header = (shell: HeaderShell = shellOf(), effective: EffectiveLimits = limits('green')) => <Header shell={shell} state={STATE} effective={effective} />;
const banner = (): HTMLElement => screen.getByRole('banner');
const column = (name: 'left' | 'center' | 'right'): HTMLElement | null => banner().querySelector<HTMLElement>(`[data-header-column="${name}"]`);
const brand = (): HTMLElement => screen.getByRole('button', { name: 'hive · workers 1/5' });

beforeEach(() => setLanguage('pt'));
afterEach(() => setShortcuts({}));

test('the brand reads hive · workers {active}/{max} in the left column, the max the effective cap when a rule sets one (#221)', () => {
  const { rerender } = render(header());
  expect(column('left')).toContainElement(brand());
  rerender(header(shellOf(), limits('green', 2)));
  expect(screen.getByRole('button', { name: 'hive · workers 1/2' })).toBeInTheDocument();
});

test('the brand\'s title names the signal and what it holds back, a green holding nothing back has no middle part; the mark takes the signal\'s colour (#221, #533)', () => {
  const { rerender } = render(header(shellOf(), limits('yellow')));
  expect(brand()).toHaveAttribute('title', 'sinal yellow · tarefas novas só de árvore iniciada · clique para trocar');
  expect(brand().querySelector('[data-signal]')?.getAttribute('class')).toMatch(/text-signal-yellow/);
  rerender(header(shellOf(), limits('green')));
  expect(brand()).toHaveAttribute('title', 'sinal green · clique para trocar');
  expect(brand().querySelector('[data-signal]')?.getAttribute('class')).toMatch(/text-signal-green/);
});

test('a click on the brand opens the signal choice, the flow sidebar\'s own toggle (#221)', async () => {
  const user = userEvent.setup();
  render(header());
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  await user.click(brand());
  expect((await screen.findAllByRole('radio')).map((item) => item.textContent)).toEqual(['green', 'yellow', 'red']);
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

test('the center column holds the activity\'s bar, and is empty without one (#221)', () => {
  const { rerender } = render(header(shellOf({ bar: <p>the bar</p> })));
  expect(column('center')).toContainElement(screen.getByText('the bar'));
  rerender(header());
  expect(column('center')).toBeEmptyDOMElement();
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
});
