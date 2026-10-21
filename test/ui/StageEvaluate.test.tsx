import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { StageEvaluate } from '@/components/settings/StageEvaluate';
import { setLanguage } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-form';

beforeEach(() => setLanguage('pt'));

const AGENTS = [{ agent: 'claude' as const, available: true }, { agent: 'codex' as const, available: true }]; // AgentAvailability's shape
function Harness({ initial = {}, onUpdate }: { initial?: Partial<StageDraft>; onUpdate(patch: Partial<StageDraft>): void }) {
  const [stage, setStage] = useState<StageDraft>({ ...emptyStage('claude'), action: 'evaluate', ...initial });
  return <StageEvaluate id="s" stage={stage} agents={AGENTS} defaultAgent="claude" onUpdate={(patch) => { onUpdate(patch); setStage((s) => ({ ...s, ...patch })); }} />;
}

test('the block shows the column header, the judge row on the same columns with limiar 7, and the rubric with its hint; no reviewer yet (#877)', () => {
  render(<Harness onUpdate={vi.fn()} />);
  for (const col of ['agente', 'modelo', 'agente especializado', 'foco']) expect(screen.getAllByText(col).length).toBeGreaterThan(0);
  expect(screen.getByRole('combobox', { name: 'juiz' })).toHaveTextContent('claude');
  expect(screen.getByRole('combobox', { name: 'modelo do juiz' })).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'limiar' })).toHaveValue(7);
  expect(screen.getByText('nota de 0 a 10')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'rubrica' })).toHaveValue('');
  expect(screen.queryByRole('group', { name: /revisor 1/ })).not.toBeInTheDocument();
});

test('+ revisor adds a row on the default agent; remover revisor removes it; the focus is typed into its row (#877)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness onUpdate={onUpdate} />);
  await user.click(screen.getByRole('button', { name: '+ revisor' }));
  const row = screen.getByRole('group', { name: 'revisor 1' });
  expect(within(row).getByRole('combobox', { name: 'agente do revisor 1' })).toHaveTextContent('claude');
  await user.type(within(row).getByRole('textbox', { name: 'foco do revisor 1' }), 'security');
  expect(onUpdate).toHaveBeenLastCalledWith({ reviewers: [expect.objectContaining({ agent: 'claude', focus: 'security' })] });
  await user.click(screen.getByRole('button', { name: 'remover revisor 1' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ reviewers: [] });
});

test('another agent on a row clears its model and specialized agent (#710 decision 8, #877)', async () => {
  const onUpdate = vi.fn();
  render(<Harness initial={{ reviewers: [{ id: 'r1', agent: 'claude', model: 'opus', specializedAgent: 'hive:x', focus: 'f' }] }} onUpdate={onUpdate} />);
  const trigger = screen.getByRole('combobox', { name: 'agente do revisor 1' });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 }); // jsdom has no layout: a Radix Select trigger needs the pointer events to open
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: 'codex' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ reviewers: [{ id: 'r1', agent: 'codex', model: '', specializedAgent: '', focus: 'f' }] });
});

test('the threshold and the rubric are written as typed (#877)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness onUpdate={onUpdate} />);
  const threshold = screen.getByRole('spinbutton', { name: 'limiar' });
  await user.clear(threshold);
  await user.type(threshold, '8');
  expect(onUpdate).toHaveBeenLastCalledWith({ threshold: '8' });
  await user.type(screen.getByRole('textbox', { name: 'rubrica' }), 'a');
  expect(onUpdate).toHaveBeenLastCalledWith({ rubric: 'a' });
});
