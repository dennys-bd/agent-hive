import { act, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Footer } from '@/components/Footer';
import { setLanguage, t } from '@/i18n';
import type { AgentId } from '../../src/types';
import { FIRED, NONE, STATE } from './rules-fixtures';

const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const footer = (): HTMLElement => screen.getByRole('contentinfo');
const row = (): HTMLElement => footer().firstElementChild as HTMLElement; // the footer's one child (#227): the row that holds and clips the items
// The usage group (#223) has its own tests (AgentUsage, UsagePanel): the lists below are the rest of the footer
const outsideUsage = (b: HTMLElement): boolean => b.closest('[data-usage-group]') === null;

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('nothing fired: the rules button reads nenhuma ativa, then the power buttons', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(within(footer()).getAllByRole('button').filter(outsideUsage).map((b) => b.textContent)).toEqual(['regras nenhuma ativa', '', '']); // keep awake and shutdown, icon only (#226)
});

test('fired rules: one rules button naming the effects in force, no rule chips', () => {
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(within(footer()).getAllByRole('button').filter(outsideUsage).map((b) => b.textContent)).toEqual(['regras máx 2 workers · review 1 · sinal yellow', '', '']);
  expect(footer()).not.toHaveTextContent('≥');
});

test('the footer holds no signal pill, no effect and no workers count: the header\'s brand shows them (#221, #227)', () => {
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(within(footer()).queryByRole('status')).not.toBeInTheDocument();
  expect(footer()).not.toHaveTextContent(/workers \d+\/\d+/);
  expect(footer()).not.toHaveTextContent('tarefas novas só de árvore iniciada');
});

test('the footer ends in the power buttons, armed or not: no shutting-down text and no cancelar button (#226)', () => {
  const { rerender } = render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(within(footer()).getByRole('button', { name: t('power.keepAwake.off') })).toBeInTheDocument();
  expect(within(footer()).getByRole('button', { name: t('power.shutdown.off') })).toBeInTheDocument();
  rerender(<Footer state={{ ...STATE, shutdown: { armedAt: '2026-09-28T10:00:00Z' }, keepAwake: true }} effective={NONE} locale="pt-BR" />);
  expect(footer()).not.toHaveTextContent('desligando quando os workers terminarem');
  expect(within(footer()).queryByRole('button', { name: 'cancelar' })).not.toBeInTheDocument();
  expect(within(footer()).getByRole('button', { name: t('power.keepAwake.on') })).toBeInTheDocument();
  expect(within(footer()).getByRole('button', { name: t('power.shutdown.on') })).toBeInTheDocument();
});

test('the usage group is the row\'s first child in its full form, then a separator, then the rules button; the footer anchors the usage panel (#223, #227)', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  const [usage, separator, rules] = [...row().children] as HTMLElement[];
  expect(usage).toHaveAttribute('data-usage-group');
  expect(within(usage).getByTitle(/^claude · sem 91% · reinicia 4d10h/)).toBeInTheDocument();
  expect(usage.querySelector('[data-slot="progress"]')).toHaveClass('w-14');
  expect(within(usage).getByTitle('codex · sem leitura')).toBeInTheDocument();
  expect(separator).toHaveClass('h-3.5', 'w-px', 'bg-border');
  expect(rules).toHaveTextContent('regras nenhuma ativa');
  expect(footer()).toHaveClass('relative');
});

test('the row never wraps: every item is whitespace-nowrap and shrink-0, and the row clips, not the footer, so the usage panel above it shows (#227)', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(row()).toHaveClass('overflow-hidden', '*:shrink-0', '*:whitespace-nowrap');
  expect(footer()).not.toHaveClass('overflow-hidden');
});

test('the checkers and the problems sit right of the spacer, before the console, a separator between the problems and the console (#225)', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" checkers={<span>checkers</span>} problems={<span>problems</span>} console={<span>console</span>} />);
  const [checkers, problems, chip] = ['checkers', 'problems', 'console'].map((text) => screen.getByText(text));
  expect(checkers.previousElementSibling).toHaveClass('flex-1');
  expect(checkers.nextElementSibling).toBe(problems);
  expect(problems.nextElementSibling).toHaveClass('bg-border');
  expect(problems.nextElementSibling?.nextElementSibling).toBe(chip);
});

describe('the steps (#227, handoff §6)', () => {
  // jsdom lays nothing out: the row's content width is a width per form rendered, read from the footer's data-usage / data-rules
  const CHIP_WIDTH: Record<string, number> = { full: 250, compact: 150, minimal: 90 };
  const GROUP_WIDTH = 130;
  const RULES_WIDTH: Record<string, number> = { full: 200, short: 100 };
  const FIXED_WIDTH = 450; // checkers, problems, console, power buttons, separators: the same at every step
  const TWO: readonly AgentId[] = ['claude', 'codex'];
  const TEN = ['claude', 'codex', 'kiro', 'amp', 'gemini', 'qwen', 'cursor', 'goose', 'aider', 'opencode'] as unknown as AgentId[]; // AGENT_IDS has two: the seam stands in for more
  const observers: ResizeObserverCallback[] = [];
  let windowWidth = 0;
  let agentCount = 0;
  const isRow = (el: Element): boolean => el.parentElement?.tagName === 'FOOTER';
  const contentWidth = (el: Element): number => {
    const { usage = '', rules = '' } = (el.closest('footer') as HTMLElement).dataset;
    return FIXED_WIDTH + (usage === 'group' ? GROUP_WIDTH : agentCount * CHIP_WIDTH[usage]) + RULES_WIDTH[rules];
  };
  const formOf = (): string => `${footer().dataset.usage}/${footer().dataset.rules}`;
  const resize = (width: number): void => {
    windowWidth = width;
    act(() => { for (const callback of observers) callback([], {} as ResizeObserver); });
  };
  const renderAt = (width: number, agents: readonly AgentId[], extra: Partial<ComponentProps<typeof Footer>> = {}) => {
    windowWidth = width;
    agentCount = agents.length;
    return render(<Footer state={STATE} effective={FIRED} locale="pt-BR" agents={agents} {...extra} />);
  };

  beforeEach(() => {
    observers.splice(0);
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe(): void {} disconnect(): void {} });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return isRow(this) ? windowWidth : 0; });
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return isRow(this) ? Math.max(windowWidth, contentWidth(this)) : 0; });
  });

  test('at 1440px with two agents the footer is at step 0; narrower, at the first step whose content fits, down to step 7 (#227)', () => {
    renderAt(1440, TWO);
    expect(formOf()).toBe('full/full');
    resize(1100);
    expect(formOf()).toBe('full/short');
    expect(within(row()).getByText('máx 2 workers +2')).toBeInTheDocument();
    resize(1000);
    expect(formOf()).toBe('compact/full');
    expect(row().querySelector('[data-slot="progress"]')).toHaveClass('w-7');
    for (const [width, form] of [[900, 'compact/short'], [840, 'minimal/full'], [750, 'minimal/short'], [700, 'group/short']] as const) {
      resize(width);
      expect(formOf(), `${width}px`).toBe(form);
    }
  });

  test('shrinking the window and then widening it grows the footer back to a larger step (#227)', () => {
    renderAt(1440, TWO);
    resize(750);
    expect(formOf()).toBe('minimal/short');
    resize(1000);
    expect(formOf()).toBe('compact/full');
    resize(1440);
    expect(formOf()).toBe('full/full');
  });

  test('ten agents reach the group form at 1440px; below step 7\'s width it stays at step 7 (#227)', () => {
    renderAt(1440, TEN);
    expect(formOf()).toBe('group/full');
    expect(within(row()).getByText('+7')).toBeInTheDocument();
    resize(700);
    expect(formOf()).toBe('group/short');
    resize(600);
    expect(formOf()).toBe('group/short');
  });

  test('an agent that goes away starts the descent over from step 0 without a resize (#227)', () => {
    const { rerender } = renderAt(1100, TWO);
    expect(formOf()).toBe('full/short');
    agentCount = 1;
    rerender(<Footer state={STATE} effective={FIRED} locale="pt-BR" agents={['claude']} />);
    expect(formOf()).toBe('full/full');
  });

  test('checkers, problems, console and the power buttons render the same at step 0 and step 7 (#227)', () => {
    renderAt(1440, TWO, { checkers: <span>checkers</span>, problems: <span>problems</span>, console: <span>console</span> });
    const fixed = (): string[] => {
      const items = [...row().children];
      return items.slice(items.findIndex((el) => el.classList.contains('flex-1')) + 1).map((el) => el.outerHTML);
    };
    const atStepZero = fixed();
    resize(400);
    expect(formOf()).toBe('group/short');
    expect(fixed()).toEqual(atStepZero);
  });
});
