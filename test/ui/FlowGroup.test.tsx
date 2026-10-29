import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { FlowGroup } from '@/components/benchmark/arms/FlowGroup';
import { setLanguage } from '@/i18n';
import { ARMS_FLOW } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));

test('the flow row names the workspace, the copy date and what it dropped; the chart picks (#536)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<FlowGroup workspace="agent-hive" flow={{ ...ARMS_FLOW, dropped: ['Spec.from'] }} picked="Spec" onPick={onPick} marked={new Set()} isArm={false} editor={<p>editor</p>} />);
  expect(screen.getByRole('button', { name: 'fluxo' })).toHaveTextContent('agent-hive');
  expect(screen.getByRole('button', { name: 'fluxo' })).toBeDisabled();
  expect(screen.getByText(/^cópia de .* · mudar o fluxo em settings não muda este experimento$/)).toBeInTheDocument();
  expect(screen.getByText('a cópia tirou: Spec.from')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^PR/ }));
  expect(onPick).toHaveBeenCalledWith('PR');
  expect(screen.getByText('editor')).toBeInTheDocument();
});

test('nothing dropped, no note; in an arm the state reads igual à base (#536)', () => {
  render(<FlowGroup workspace="agent-hive" flow={ARMS_FLOW} picked="Spec" onPick={vi.fn()} marked={new Set()} isArm editor={null} />);
  expect(screen.queryByText(/a cópia tirou/)).not.toBeInTheDocument();
  expect(screen.getByText('igual à base')).toBeInTheDocument();
});

test('abrir em settings: the base calls the slot; without the prop, or in an arm, there is no link (#536)', async () => {
  const user = userEvent.setup();
  const onOpenSettings = vi.fn();
  const props = { workspace: 'agent-hive', flow: ARMS_FLOW, picked: 'Spec', onPick: vi.fn(), marked: new Set<string>(), editor: null };
  const view = render(<FlowGroup {...props} isArm={false} onOpenSettings={onOpenSettings} />);
  await user.click(screen.getByRole('button', { name: 'abrir em settings' }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  view.rerender(<FlowGroup {...props} isArm={false} />);
  expect(screen.queryByRole('button', { name: 'abrir em settings' })).not.toBeInTheDocument();
  view.rerender(<FlowGroup {...props} isArm onOpenSettings={onOpenSettings} />);
  expect(screen.queryByRole('button', { name: 'abrir em settings' })).not.toBeInTheDocument();
});
