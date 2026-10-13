import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RulesPanel } from '@/components/footer/RulesPanel';
import { setLanguage } from '@/i18n';
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { DAY_STAGE, FIRED, NONE, SESSION_FORCE, STATE, WEEK_CAP } from './rules-fixtures';

const WEEK_70: UsageRule = { source: 'week', percent: 70, maxWorkers: 4 };
const WEEK_95: UsageRule = { source: 'week', percent: 95, maxWorkers: 1 };
const RULES: State = { ...STATE, usageRules: [DAY_STAGE, WEEK_CAP, SESSION_FORCE, WEEK_95, WEEK_70] };

const panel = (state: State, effective: EffectiveLimits, onEditRules = vi.fn(), onClose = vi.fn()) =>
  render(<RulesPanel state={state} effective={effective} locale="pt-BR" onEditRules={onEditRules} onClose={onClose} />);
const block = (name: string): HTMLElement => screen.getByRole('group', { name });
const blockNames = (): (string | null)[] => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label'));

beforeEach(() => setLanguage('pt'));

test('the header counts the rules and the fired ones; every rule shows once, in its measure\'s block, by percent, with its state; the ticks mark what fired', () => {
  panel(RULES, FIRED);
  expect(screen.getByText('regras de uso')).toBeInTheDocument();
  expect(screen.getByText('5 regras · 4 dispararam')).toBeInTheDocument();
  expect(blockNames()).toEqual(['janela da sessão (5h)', 'janela da semana', 'orçamento por dia']);
  expect(within(block('janela da sessão (5h)')).getByText('nada medido ainda')).toBeInTheDocument();
  const week = block('janela da semana');
  expect(within(week).getByText('agora 91%')).toBeInTheDocument();
  expect(within(week).getAllByRole('button').map((b) => b.textContent)).toEqual([
    '70% → limitar workers a 4 disparou · menos restritiva', '90% → limitar workers a 2 valendo', '95% → limitar workers a 1 faltam 4%',
  ]);
  expect(within(week).getAllByTestId('rules-tick').map((tick) => tick.dataset.fired)).toEqual(['true', 'true', 'false']);
  expect(within(block('orçamento por dia')).getByRole('button', { name: /80% → limitar workers de review a 1/ })).toHaveTextContent('valendo');
  expect(screen.getAllByRole('button', { name: /%/ })).toHaveLength(5);
  expect(screen.getByText('vale a regra mais restritiva que disparou, em qualquer medida.')).toBeInTheDocument();
});

test('two agents\' session rules give two blocks, the default agent\'s first and the other named', () => {
  const codexSession: UsageRule = { source: 'session', percent: 50, maxWorkers: 1, agent: 'codex' };
  panel({ ...STATE, usageRules: [codexSession, SESSION_FORCE] }, NONE);
  expect(blockNames()).toEqual(['janela da sessão (5h)', 'janela da sessão (5h) · codex']);
});

test('a signal rule carries a dot in its signal\'s colour; a cap rule has none', () => {
  panel(RULES, FIRED);
  const signalRow = screen.getByRole('button', { name: /60% → mudar o sinal para yellow/ });
  expect(signalRow.querySelector('[data-signal="yellow"]')).toHaveClass('bg-signal-yellow');
  expect(screen.getByRole('button', { name: /90% → limitar workers a 2/ }).querySelector('[data-signal]')).toBeNull();
});

test('a paused rule is struck through with pausada and its time, and is not counted as fired', () => {
  const backAt = new Date(Date.now() + 52 * 60_000 + 30_000).toISOString();
  panel(RULES, { ...FIRED, capRules: [], disabledRules: [{ rule: WEEK_CAP, until: 'at', backAt, estimate: false }] });
  const row = screen.getByRole('button', { name: /90% → limitar workers a 2/ });
  expect(row).toHaveTextContent('pausada · 52 min');
  expect(row.querySelector('.line-through')).toHaveTextContent('90% → limitar workers a 2');
  expect(screen.getByText('5 regras · 3 dispararam')).toBeInTheDocument();
});

test('editar… calls onEditRules and × calls onClose', async () => {
  const user = userEvent.setup();
  const onEditRules = vi.fn();
  const onClose = vi.fn();
  panel(RULES, FIRED, onEditRules, onClose);
  await user.click(screen.getByRole('button', { name: 'editar…' }));
  expect(onEditRules).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('with no rules the panel shows the header and the footnote only', () => {
  panel(STATE, NONE);
  expect(screen.getByText('0 regras · 0 dispararam')).toBeInTheDocument();
  expect(blockNames()).toEqual([]);
  expect(screen.getByText('vale a regra mais restritiva que disparou, em qualquer medida.')).toBeInTheDocument();
});
