import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ArmsTab } from '@/components/benchmark/arms/ArmsTab';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { ARMS, stubBenchmarkFetch } from './benchmark-fixtures';

function Tab({ experiment = ARMS }: { experiment?: Experiment }) {
  const benchmark = useBenchmark([experiment]);
  return <ArmsTab experiment={experiment} benchmark={benchmark} />;
}
const card = (letter: string): HTMLElement => screen.getByRole('region', { name: `braço ${letter}` });
const WARNING = 'tarefas diferentes da base · comparação só por run';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test("the screen's sample: counts, rows, B's none line, D's struck base tasks and yellow line, the footers (#462)", () => {
  render(<Tab />);
  expect(['A', 'B', 'C', 'D'].map((l) => within(card(l)).getByText(/^\d+ sobreposiç/).textContent)).toEqual(['2 sobreposições', '0 sobreposições', '1 sobreposição', '1 sobreposição']);
  expect(within(card('A')).getByText('+ superpowers, ecc')).toBeInTheDocument();
  expect(within(card('B')).getByText('nenhuma sobreposição · este braço é a própria base')).toBeInTheDocument();
  expect(within(card('B')).getByText('igual à base: tudo')).toBeInTheDocument();
  expect(within(card('C')).getByText('codex · gpt-5')).toBeInTheDocument();
  expect(within(card('C')).getByText('claude · sonnet')).toHaveClass('line-through');
  expect(within(card('D')).getByText('3 tarefas · 0 bloqueios')).toBeInTheDocument();
  expect(within(card('D')).getByText('8 tarefas da base')).toHaveClass('line-through');
  expect(within(card('D')).getByText(WARNING)).toBeInTheDocument();
  expect(within(card('A')).queryByText(WARNING)).not.toBeInTheDocument();
});

test('the base card lists the stages, skills, the pinned plugin and seed, the tasks with their hash and the rules (#462)', () => {
  render(<Tab />);
  const base = within(screen.getByRole('region', { name: 'base' }));
  expect(base.getByText('claude · haiku')).toBeInTheDocument();
  expect(base.getByText('/hive:new-spec /hive:new-plan /hive:new-build /hive:new-pr')).toBeInTheDocument();
  expect(base.getByText(`hive ${ARMS.plugin.version} · ${ARMS.plugin.hash.slice(0, 6)}`)).toBeInTheDocument();
  expect(base.getByText('8 tarefas · 3 bloqueios · t·91d4')).toBeInTheDocument();
  expect(base.getByText('14 permitidas · gh, push * negadas')).toBeInTheDocument();
});

test("abrir settings opens the arm's settings, and on the base card the base mode (#462)", async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  render(<Tab />);
  await user.click(within(card('C')).getByRole('button', { name: 'abrir settings' }));
  expect(await screen.findByRole('dialog', { name: 'braço C · plugin + codex' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await user.click(within(screen.getByRole('region', { name: 'base' })).getByRole('button', { name: 'abrir settings' }));
  expect(await screen.findByRole('dialog', { name: 'base · todos os braços' })).toBeInTheDocument();
});
