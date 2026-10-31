import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AgentUsage } from '@/components/footer/AgentUsage';
import { setLanguage } from '@/i18n';
import type { RateLimits } from '../../src/types';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const MIN = 60_000;
const claude: RateLimits = {
  at: new Date(NOW.getTime() - 2 * MIN).toISOString(),
  windows: {
    five_hour: { usedPercent: 5, resetsAt: new Date(NOW.getTime() + 99 * MIN).toISOString() },
    seven_day: { usedPercent: 92, resetsAt: new Date(NOW.getTime() + (5 * 24 + 3) * 60 * MIN).toISOString() },
  },
};
const ok = (): Response => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
let answer: (res: Response) => void = () => undefined;
const fetchMock = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>((resolve) => { answer = resolve; }));
const chip = (): HTMLElement => screen.getByRole('button', { name: /^claude ·/ });
const spinning = (button: HTMLElement): boolean => button.querySelector('svg')?.classList.contains('animate-spin') ?? false;

beforeEach(() => { setLanguage('pt'); vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('a chip opens the panel: title, count, ↻ todos and ×; per agent its age, ↻ and windows with long labels and resets; focus moves in (#223)', async () => {
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  await userEvent.setup().click(chip());
  const panel = screen.getByRole('dialog', { name: 'uso dos agentes' });
  expect(chip()).toHaveAttribute('aria-expanded', 'true');
  expect(panel).toHaveFocus();
  expect(panel).toHaveClass('absolute', 'bottom-full', 'left-0', 'w-[440px]', 'max-h-[440px]', 'rounded-tr-[8px]', 'border-b-0', 'bg-popover');
  expect(panel).toHaveTextContent('2 agentes');
  expect(within(panel).getByRole('button', { name: '↻ todos' })).toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: 'fechar' })).toBeInTheDocument();
  const [claudeRow, codexRow] = within(panel).getAllByRole('listitem');
  expect(claudeRow).toHaveTextContent('claudelido há 2 min');
  expect(claudeRow).toHaveTextContent('sessão5%reinicia 1h39m');
  expect(claudeRow).toHaveTextContent('semana92%reinicia 5d3h');
  expect(within(claudeRow).getByText('reinicia 5d3h')).toHaveClass('text-destructive');
  expect(within(claudeRow).getByRole('button', { name: 'atualizar claude · lido há 2 min' })).toBeInTheDocument();
  expect(codexRow).toHaveTextContent('codexsem leitura');
  expect(within(codexRow).getByRole('button', { name: 'atualizar codex · sem leitura' })).toBeInTheDocument();
});

test('↻ todos posts {} and spins every ↻, chip and panel alike, until the answer; the panel stays open (#223)', async () => {
  const user = userEvent.setup();
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  await user.click(chip());
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '↻ todos' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/plan-limits/refresh', expect.objectContaining({ body: '{}' }));
  const all = screen.getAllByRole('button', { name: /^atualizar/ });
  expect(all).toHaveLength(4); // two chips, two rows
  expect(all.every(spinning)).toBe(true);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  answer(ok());
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^atualizar/ }).some(spinning)).toBe(false));
});

test('a row\'s ↻ posts its agent and spins that agent\'s ↻ only (#223)', async () => {
  const user = userEvent.setup();
  render(<AgentUsage state={{ rateLimits: { claude } }} form="full" />);
  await user.click(chip());
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'atualizar codex · sem leitura' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/plan-limits/refresh', expect.objectContaining({ body: '{"agent":"codex"}' }));
  expect(screen.getAllByRole('button', { name: 'atualizar codex · sem leitura' }).every(spinning)).toBe(true);
  expect(screen.getAllByRole('button', { name: 'atualizar claude · lido há 2 min' }).some(spinning)).toBe(false);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  answer(ok());
});

test('×, Escape, a click outside and a second click on the chip close it; a click inside keeps it; focus goes back to the chip (#223)', async () => {
  const user = userEvent.setup();
  render(<><button type="button">outside</button><AgentUsage state={{ rateLimits: { claude } }} form="full" /></>);
  const open = async (): Promise<HTMLElement> => { await user.click(chip()); return screen.getByRole('dialog'); };
  await user.click(within(await open()).getByRole('button', { name: 'fechar' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(chip()).toHaveFocus();
  await open();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(chip()).toHaveFocus();
  await user.click(within(await open()).getByText('uso dos agentes'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'outside' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await open();
  await user.click(chip());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(chip()).toHaveAttribute('aria-expanded', 'false');
});

test('a window past its reset reads 0%: the session and the 30 days their length, bare; the week reinicia and the time to its next reset (#557)', async () => {
  const hoursAgo = (n: number): string => new Date(NOW.getTime() - n * 60 * MIN).toISOString();
  const pastClaude: RateLimits = { at: claude.at, windows: { five_hour: { usedPercent: 80, resetsAt: hoursAgo(1) }, seven_day: { usedPercent: 92, resetsAt: hoursAgo(48) } } };
  const pastCodex: RateLimits = { at: claude.at, windows: { thirty_day: { usedPercent: 46, resetsAt: hoursAgo(1) } } };
  render(<AgentUsage state={{ rateLimits: { claude: pastClaude, codex: pastCodex } }} form="full" />);
  expect(screen.getByTitle(/^codex ·/)).toHaveTextContent('30d0%30d');
  await userEvent.setup().click(chip());
  const [claudeRow, codexRow] = within(screen.getByRole('dialog')).getAllByRole('listitem');
  expect(claudeRow).toHaveTextContent('sessão0%5h');
  expect(within(claudeRow).queryByText(/reinicia 5h/)).toBeNull();
  expect(claudeRow).toHaveTextContent('semana0%reinicia 5d');
  expect(codexRow).toHaveTextContent('30 dias0%30d');
});
