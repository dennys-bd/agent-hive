import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Footer } from '@/components/Footer';
import { setLanguage, t } from '@/i18n';
import { SIGNALS_DEFAULTS } from '../../src/types';
import { FIRED, NONE, STATE } from './rules-fixtures';

const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const footer = (): HTMLElement => screen.getByRole('contentinfo');
// The usage group (#223) has its own tests (AgentUsage, UsagePanel): the lists below are the rest of the footer
const outsideUsage = (b: HTMLElement): boolean => b.closest('[data-usage-group]') === null;

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('green with nothing fired: the pill, no effect, the workers (the own session not counted), the rules button reading nenhuma ativa, and the power buttons', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(within(footer()).getByRole('status')).toHaveAttribute('data-signal', 'green');
  expect(within(footer()).getByRole('status')).toHaveTextContent('green');
  expect(footer()).toHaveTextContent('workers 1/5');
  expect(footer()).not.toHaveTextContent(t('signal.effect.noNewTasks'));
  expect(within(footer()).getAllByRole('button').filter(outsideUsage).map((b) => b.textContent)).toEqual(['regras nenhuma ativa', '', '']); // keep awake and shutdown, icon only (#226)
});

test('fired rules: the signal named in English with its effect in Portuguese, the effective cap, and one rules button naming the effects in force, no rule chips', () => {
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(within(footer()).getByRole('status')).toHaveTextContent('yellow');
  expect(footer()).toHaveTextContent('tarefas novas só de árvore iniciada');
  expect(footer()).toHaveTextContent('workers 1/2');
  expect(within(footer()).getAllByRole('button').filter(outsideUsage).map((b) => b.textContent)).toEqual(['regras máx 2 workers · review 1 · sinal yellow', '', '']);
  expect(footer()).not.toHaveTextContent('≥');
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

test('the effect is read from the signal\'s row: what it holds back, joined; a row that holds nothing back reads like green; green says nothing (#727)', () => {
  const { rerender } = render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('tarefas novas só de árvore iniciada');
  rerender(<Footer state={STATE} effective={{ ...FIRED, signal: 'red' }} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('sem tarefas novas · nada segue');
  const open = { ...SIGNALS_DEFAULTS, yellow: { newTasks: 'always' as const, started: 'resumeAndContinue' as const, workerless: true } };
  rerender(<Footer state={{ ...STATE, signals: open }} effective={FIRED} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('como green');
  rerender(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(footer()).not.toHaveTextContent('como green');
  expect(within(footer()).queryByRole('button', { name: 'auto desligado' })).not.toBeInTheDocument();
});

test('the usage group is the footer\'s first child in its full form, then a separator, then the signal pill; the footer anchors its panel (#223)', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  const [usage, separator, pill] = [...footer().children] as HTMLElement[];
  expect(usage).toHaveAttribute('data-usage-group');
  expect(within(usage).getByTitle(/^claude · sem 91% · reinicia 4d10h/)).toBeInTheDocument();
  expect(usage.querySelector('[data-slot="progress"]')).toHaveClass('w-14');
  expect(within(usage).getByTitle('codex · sem leitura')).toBeInTheDocument();
  expect(separator).toHaveClass('h-3.5', 'w-px', 'bg-border');
  expect(pill).toContainElement(within(footer()).getByRole('status'));
  expect(footer()).toHaveClass('relative');
});

test('the checkers and the problems sit right of the spacer, before the console, a separator between the problems and the console (#225)', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" checkers={<span>checkers</span>} problems={<span>problems</span>} console={<span>console</span>} />);
  const [checkers, problems, chip] = ['checkers', 'problems', 'console'].map((text) => screen.getByText(text));
  expect(checkers.previousElementSibling).toHaveClass('flex-1');
  expect(checkers.nextElementSibling).toBe(problems);
  expect(problems.nextElementSibling).toHaveClass('bg-border');
  expect(problems.nextElementSibling?.nextElementSibling).toBe(chip);
});
