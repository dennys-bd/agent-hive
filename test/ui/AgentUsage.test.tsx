import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AgentUsage } from '@/components/footer/AgentUsage';
import { setLanguage } from '@/i18n';
import type { AgentId, RateLimits } from '../../src/types';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const claude: RateLimits = {
  at: ago(2 * MIN),
  windows: { five_hour: { usedPercent: 5, resetsAt: ahead(99 * MIN) }, seven_day: { usedPercent: 92, resetsAt: ahead((5 * 24 + 3) * 60 * MIN) } },
};
const codex: RateLimits = { at: ago(0), windows: { thirty_day: { usedPercent: 40, resetsAt: ahead(60 * MIN) } } };
const ok = (): Response => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
const bars = (el: Element): Element[] => [...el.querySelectorAll('[data-slot="progress"]')];
const indicator = (bar: Element): string => bar.querySelector('[data-slot="progress-indicator"]')?.getAttribute('class') ?? '';
const marks = (el: Element): Element[] => [...el.querySelectorAll('[data-icon="claude"], [data-icon="codex"], [data-mark="blank"]')];
const FIVE = ['claude', 'codex', 'kiro', 'amp', 'gemini'] as unknown as AgentId[]; // AGENT_IDS has two: the seam stands in for more

beforeEach(() => { setLanguage('pt'); vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); vi.stubGlobal('fetch', vi.fn(async () => ok())); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('full: a chip per agent with plan limits; per window its label, a 56px bar, the % and the reset; the mark in the agent\'s colour; ↻ (#223)', () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  const chip = screen.getByTitle('claude · 5h 5% · reinicia 1h39m · sem 92% · reinicia 5d3h · lido há 2 min');
  expect(chip).toHaveClass('rounded-md', 'border', 'px-2', 'py-0.5', 'whitespace-nowrap', 'shrink-0');
  expect(chip.querySelector('[data-icon="claude"]')).toHaveClass('size-3.5', 'text-agent-claude');
  expect(chip).toHaveTextContent('5h5%1h39msem92%5d3h');
  expect(chip).not.toHaveTextContent(/claude/); // the mark names the agent
  expect(bars(chip).map((bar) => bar.getAttribute('class'))).toEqual([expect.stringContaining('w-14'), expect.stringContaining('w-14')]);
  expect(bars(chip).every((bar) => bar.classList.contains('h-1') && bar.classList.contains('bg-accent'))).toBe(true);
  expect(within(chip).getByRole('button', { name: 'atualizar claude · lido há 2 min' })).toHaveAttribute('title', 'atualizar claude · lido há 2 min');
});

test('an agent with plan limits and no reading still has its chip: its mark, sem leitura and its ↻ (#223)', () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  const chip = screen.getByTitle('codex · sem leitura');
  expect(chip.querySelector('[data-icon="codex"]')).toHaveClass('text-agent-codex');
  expect(within(chip).getByText('sem leitura')).toHaveClass('text-muted-foreground');
  expect(within(chip).getByRole('button', { name: 'atualizar codex · sem leitura' })).toBeInTheDocument();
});

test('from RED_AT the %, the reset and the fill turn destructive; below they stay muted on a foreground fill (#223)', () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  const [fiveHour, week] = bars(screen.getByTitle(/^claude ·/));
  expect(screen.getByText('92%')).toHaveClass('text-destructive', 'min-w-7', 'text-right');
  expect(screen.getByText('5d3h')).toHaveClass('text-destructive');
  expect(indicator(week)).toMatch(/bg-destructive/);
  expect(screen.getByText('5%')).toHaveClass('text-muted-foreground');
  expect(screen.getByText('1h39m')).toHaveClass('text-muted-foreground');
  expect(indicator(fiveHour)).toMatch(/bg-foreground/);
  expect(indicator(fiveHour)).not.toMatch(/bg-destructive/);
});

test('a window\'s label, %, reset and fill share its band: muted at 69%, yellow at 72%, destructive at 90% (#299)', () => {
  const windows = { five_hour: { usedPercent: 69, resetsAt: ahead(99 * MIN) }, seven_day: { usedPercent: 72, resetsAt: ahead(330 * MIN) } };
  const thirty = { thirty_day: { usedPercent: 90, resetsAt: ahead(60 * MIN) } };
  render(<AgentUsage state={{ rateLimits: { claude: { at: ago(0), windows }, codex: { at: ago(0), windows: thirty } } }} form="full" />);
  const claudeChip = within(screen.getByTitle(/^claude ·/));
  const [muted, yellow] = bars(screen.getByTitle(/^claude ·/));
  for (const text of ['5h', '69%', '1h39m']) expect(claudeChip.getByText(text)).toHaveClass('text-muted-foreground');
  expect(indicator(muted)).toMatch(/bg-foreground/);
  for (const text of ['sem', '72%', '5h30m']) expect(claudeChip.getByText(text)).toHaveClass('text-signal-yellow');
  expect(indicator(yellow)).toMatch(/bg-signal-yellow/);
  const codexChip = within(screen.getByTitle(/^codex ·/));
  for (const text of ['30d', '90%', '1h']) expect(codexChip.getByText(text)).toHaveClass('text-destructive');
  expect(indicator(bars(screen.getByTitle(/^codex ·/))[0])).toMatch(/bg-destructive/);
});

test('compact: 28px bars, no reset time, ↻ kept (#223)', () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="compact" />);
  const chip = screen.getByTitle(/^claude ·/);
  expect(bars(chip).map((bar) => bar.classList.contains('w-7'))).toEqual([true, true]);
  expect(screen.queryByText('1h39m')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^atualizar/ })).toHaveLength(2);
});

test('minimal: the mark and the highest % in its band, — without a reading; no bars, no ↻ (#223)', () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="minimal" />);
  expect(within(screen.getByTitle(/^claude ·/)).getByText('92%')).toHaveClass('text-destructive');
  expect(within(screen.getByTitle('codex · sem leitura')).getByText('—')).toHaveClass('text-muted-foreground');
  expect(bars(document.body)).toHaveLength(0);
  expect(screen.queryAllByRole('button', { name: /^atualizar/ })).toHaveLength(0);
});

test('an agent without an icon gets a 14×14 blank, never its name (#223)', () => {
  render(<AgentUsage state={{}} form="full" agents={['kiro'] as unknown as AgentId[]} />);
  const chip = screen.getByTitle('kiro · sem leitura');
  expect(chip.querySelector('[data-mark="blank"]')).toHaveClass('size-3.5', 'shrink-0');
  expect(chip).not.toHaveTextContent(/kiro/);
});

test('a chip\'s ↻ posts its agent only and spins, disabled, until the answer; the other ↻ stays still; the panel stays shut (#223)', async () => {
  let answer: (res: Response) => void = () => undefined;
  const fetchMock = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>((resolve) => { answer = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  const mine = screen.getByRole('button', { name: 'atualizar claude · lido há 2 min' });
  const other = screen.getByRole('button', { name: 'atualizar codex · sem leitura' });
  await userEvent.setup().click(mine);
  expect(fetchMock).toHaveBeenLastCalledWith('/plan-limits/refresh', expect.objectContaining({ method: 'POST', body: '{"agent":"claude"}' }));
  expect(mine).toBeDisabled();
  expect(mine.querySelector('svg')).toHaveClass('animate-spin');
  expect(other.querySelector('svg')).not.toHaveClass('animate-spin');
  expect(document.querySelector('[aria-expanded="true"]')).toBeNull();
  answer(ok());
  await waitFor(() => expect(mine).toBeEnabled());
  expect(mine.querySelector('svg')).not.toHaveClass('animate-spin');
});

test('group: one button with the first three marks stacked, +2, the top agent with its % and ⌄; none read shows the first with — (#223)', () => {
  const { unmount } = render(<AgentUsage state={{ rateLimits: { claude, codex } }} form="group" agents={FIVE} />);
  const group = screen.getByRole('button', { name: 'uso dos agentes' });
  expect(screen.getAllByRole('button')).toEqual([group]); // no ↻ in the group form
  expect(marks(group)).toHaveLength(3);
  expect(marks(group)[1].parentElement).toHaveClass('-ml-1', 'ring-2', 'ring-background');
  expect(within(group).getByText('+2')).toBeInTheDocument();
  expect(within(group).getByText('claude 92%')).toHaveClass('text-destructive');
  unmount();
  render(<AgentUsage state={{}} form="group" />);
  expect(within(screen.getByRole('button', { name: 'uso dos agentes' })).getByText('claude —')).toHaveClass('text-muted-foreground');
});
