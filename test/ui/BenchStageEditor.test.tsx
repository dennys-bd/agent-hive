import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { StageEditor } from '@/components/benchmark/arms/StageEditor';
import { AgentsContext } from '@/components/NewRunButton';
import { setLanguage } from '@/i18n';
import { ARMS_FLOW } from './benchmark-fixtures';

const AGENTS = [{ agent: 'claude' as const, available: true }, { agent: 'codex' as const, available: true }];
beforeEach(() => setLanguage('pt'));
const renderWithAgents = (ui: ReactElement) => render(<AgentsContext.Provider value={AGENTS}>{ui}</AgentsContext.Provider>);
const [spec, , build, checks, evaluate] = ARMS_FLOW.stages;

test('a prompt stage: agent, model, the read-only skill line from its prompt, and the editable prompt (#536)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  renderWithAgents(<StageEditor stage={spec} base={spec} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={onChange} />);
  expect(screen.getByRole('textbox', { name: 'skill de Spec' })).toHaveAttribute('readonly');
  expect(screen.getByRole('textbox', { name: 'skill de Spec' })).toHaveValue('/hive:new-spec');
  await user.type(screen.getByRole('textbox', { name: 'prompt de Spec' }), '!');
  expect(onChange).toHaveBeenLastCalledWith({ ...spec, prompt: `${spec.prompt}!` });
  expect(screen.getByRole('combobox', { name: 'agente de Spec' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'modelo de Spec' })).toHaveTextContent('sonnet');
});

test('a skill stage edits its bare skill name (#536)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const skill = { name: 'Plan', action: 'skill' as const, skill: 'new-pla' };
  renderWithAgents(<StageEditor stage={skill} base={skill} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={onChange} />);
  await user.type(screen.getByRole('textbox', { name: 'skill de Plan' }), 'n');
  expect(onChange).toHaveBeenLastCalledWith({ ...skill, skill: 'new-plan' });
});

test('a commands stage lists its commands with their lines; evaluate shows reviewers, the judge and the threshold; lines under each (#536)', () => {
  renderWithAgents(<StageEditor stage={checks} base={checks} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={vi.fn()} />);
  expect(screen.getByText('lint')).toHaveAttribute('title', 'pnpm lint');
  expect(screen.getByText('passou quando todos saem com 0, senão falhou')).toBeInTheDocument();
});

test('evaluate: reviewers, judge and threshold, with the entries line (#536)', () => {
  renderWithAgents(<StageEditor stage={evaluate} base={evaluate} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={vi.fn()} />);
  expect(screen.getByText('hive:code-reviewer')).toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'limiar' })).toHaveValue(7);
  expect(screen.getByRole('combobox', { name: 'modelo do juiz' })).toHaveTextContent('fable');
  expect(screen.getByText('chega de Checks (passou)')).toBeInTheDocument();
});

test('the exits read the arrows and the tries (#536)', () => {
  renderWithAgents(<StageEditor stage={checks} base={checks} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={vi.fn()} />);
  expect(screen.getByText('até 3x')).toBeInTheDocument();
  expect(screen.getByText('↩')).toBeInTheDocument();
});

test('in an arm, a changed stage shows the base value struck (#536)', () => {
  renderWithAgents(<StageEditor stage={{ ...build, agent: 'codex', model: 'gpt-5' }} base={build} flow={ARMS_FLOW} isArm isLocked={false} onChange={vi.fn()} />);
  expect(screen.getByText('claude · sonnet').tagName).toBe('S');
});

test('locked: the comboboxes and the prompt are disabled (#536)', () => {
  renderWithAgents(<StageEditor stage={spec} base={spec} flow={ARMS_FLOW} isArm={false} isLocked onChange={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: 'agente de Spec' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'prompt de Spec' })).toBeDisabled();
});

test('a blank skill on a skill stage shows the error inline (#536)', () => {
  const skill = { name: 'Plan', action: 'skill' as const, skill: '' };
  renderWithAgents(<StageEditor stage={skill} base={skill} flow={ARMS_FLOW} isArm={false} isLocked={false} onChange={vi.fn()} />);
  expect(screen.getByText('A skill não pode ficar vazia.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'skill de Plan' })).toHaveAttribute('aria-invalid', 'true');
});
