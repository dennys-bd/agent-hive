import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ArmFlowChart } from '@/components/benchmark/arms/ArmFlowChart';
import { setLanguage } from '@/i18n';
import { ARMS_FLOW } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));

test('a node click picks it; the picked one is aria-current; a marked one has the dot; arrows carry verdicts and tries (#536)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<ArmFlowChart stages={ARMS_FLOW.stages} transitions={ARMS_FLOW.transitions} picked="Spec" marked={new Set(['Build'])} isArm onPick={onPick} />);
  expect(screen.getByRole('button', { name: /^Spec/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: /^Checks/ })).not.toHaveAttribute('aria-current');
  expect(within(screen.getByRole('button', { name: /^Build/ })).getByRole('img', { name: 'sobreposta neste braço' })).toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: /^Spec/ })).queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('falhou · 3x')).toBeInTheDocument();
  expect(screen.getByText('reprovou · 2x')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^Checks/ }));
  expect(onPick).toHaveBeenCalledWith('Checks');
});

test('the note names the override dot only in an arm (#536)', () => {
  const { rerender } = render(<ArmFlowChart stages={ARMS_FLOW.stages} transitions={ARMS_FLOW.transitions} picked="Spec" marked={new Set()} isArm={false} onPick={vi.fn()} />);
  expect(screen.getByText(/clique numa etapa/)).not.toHaveTextContent('sobreposta neste braço');
  rerender(<ArmFlowChart stages={ARMS_FLOW.stages} transitions={ARMS_FLOW.transitions} picked="Spec" marked={new Set()} isArm onPick={vi.fn()} />);
  expect(screen.getByText(/clique numa etapa/)).toHaveTextContent('sobreposta neste braço');
});
