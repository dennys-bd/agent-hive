import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { StageChart } from '@/components/settings/StageChart';
import { setLanguage } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-stages';
import { emptyTransition } from '@/lib/settings-transitions';

// Settings' chart (#134, 6b): a button per stage with its action's icon and summary, a pill per transition, both selectable.
const stage = (name: string, extra: Partial<StageDraft> = {}): StageDraft => ({ ...emptyStage(), name, ...extra });
beforeEach(() => setLanguage('pt'));

test('each stage is a pressed-or-not button with its summary; each transition a pill; a click selects either (#134)', async () => {
  const user = userEvent.setup();
  const stages = [stage('Build', { prompt: '/hive:new-build' }), stage('PR', { gate: true, approval: true })];
  const transitions = [emptyTransition(stages[0], stages), emptyTransition(stages[1], stages)];
  const onSelect = vi.fn();
  render(<StageChart stages={stages} transitions={transitions} selection={{ kind: 'stage', id: stages[0].id }} defaultAgent="claude" onSelect={onSelect} />);
  expect(screen.getByRole('button', { name: /^Build/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /^PR/ })).toHaveTextContent('aguarda aprovação');
  await user.click(screen.getByRole('button', { name: 'aprovado' }));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: 'transition', id: transitions[1].id });
  await user.click(screen.getByRole('button', { name: /^PR/ }));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: 'stage', id: stages[1].id });
  expect(screen.getByText('fim')).toBeInTheDocument();
});

test('the canvas bleeds to the card body edges on a dotted 16px grid and scrolls sideways; the chart is centred and its nodes are 64px high, radius lg (#887)', () => {
  const stages = [stage('Build', { prompt: '/hive:new-build' })];
  render(<StageChart stages={stages} transitions={[]} selection={{ kind: 'stage', id: stages[0].id }} defaultAgent="claude" onSelect={vi.fn()} />);
  const node = screen.getByRole('button', { name: /^Build/ });
  expect(node.style.height).toBe('64px');
  expect(node).toHaveClass('rounded-lg');
  const chart = node.parentElement as HTMLElement;
  expect(chart).toHaveClass('relative', 'mx-auto');
  const canvas = chart.parentElement as HTMLElement;
  expect(canvas).toHaveClass('-mx-5', 'overflow-x-auto', 'py-4');
  expect(canvas.style.backgroundSize).toBe('16px 16px');
});
