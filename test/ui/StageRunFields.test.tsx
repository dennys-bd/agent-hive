import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AgentAvailability, LaunchOptions } from '../../src/types';
import { StageEditor } from '@/components/settings/StageEditor';
import { setLanguage, t } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-form';
import type { TransitionDraft } from '@/lib/settings-transitions';

// #710: a prompt or skill stage's run fields, as the Start dialog draws them, and the skill picker
beforeEach(() => setLanguage('pt'));

const AGENTS: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }];
const PLANNER = { name: 'hive:planner', description: 'Writes the plan' };
const SKILLS = [{ name: 'new-plan', description: 'Plan stage for one task' }, { name: 'new-spec', description: 'Spec stage for one task' }];
const OPTIONS: LaunchOptions = {
  claude: { aliases: [{ id: 'opus' }], versions: [], specializedAgents: [PLANNER], skills: SKILLS, args: [] },
  codex: { aliases: [], versions: [], specializedAgents: [PLANNER], skills: SKILLS, args: [] },
};
type Flow = { stages: StageDraft[]; transitions: TransitionDraft[] };
const stage = (extra: Partial<StageDraft>): StageDraft => ({ ...emptyStage(), name: 'plan', ...extra });

function setup(initial: StageDraft, launchOptions: LaunchOptions | undefined = OPTIONS) {
  const onChange = vi.fn();
  function Harness() {
    const [flow, setFlow] = useState<Flow>({ stages: [initial], transitions: [] });
    return (
      <StageEditor
        stages={flow.stages} transitions={flow.transitions} sources={[]} agents={AGENTS} defaultAgent="claude" launchOptions={launchOptions}
        commands={[]} workspaces={['hive']} onChange={(next) => { onChange(next); setFlow(next); }}
      />
    );
  }
  render(<Harness />);
  return { user: userEvent.setup(), last: (): StageDraft => (onChange.mock.lastCall as [Flow])[0].stages[0] };
}
const menu = (name: string): HTMLElement => screen.getByRole('combobox', { name });
const listbox = (): HTMLElement => screen.getByRole('listbox');
// A pointerdown + click sequence: jsdom has no layout, and a Radix Select trigger needs the pointer events to open
function openSelect(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
}

test('hive skill shows the four run fields and the skill picker instead of the prompt; a pick writes the bare name and the chip names it', async () => {
  const { user, last } = setup(stage({ prompt: '/hive:new-plan' }));
  fireEvent.click(menu(t('settings.stages.action')));
  fireEvent.click(await screen.findByRole('option', { name: 'hive skill' }));
  expect(last()).toMatchObject({ action: 'skill', skill: '' });
  expect(screen.getByLabelText(t('settings.stages.agent'))).toHaveTextContent(/^claude$/);
  for (const name of ['modelo', 'agente especializado']) expect(menu(name)).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.stages.session'))).toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.stages.prompt'))).not.toBeInTheDocument();
  expect(menu('skill')).toHaveTextContent('escolha uma skill');
  await user.click(menu('skill'));
  expect(within(listbox()).getByText('Plan stage for one task')).toBeInTheDocument();
  await user.click(within(listbox()).getByText('hive:new-plan'));
  expect(last().skill).toBe('new-plan');
  expect(menu('skill')).toHaveTextContent('hive:new-plan');
  expect(screen.getByRole('button', { name: /^plan/ })).toHaveTextContent('claude · new-plan');
});

test('the agent field lists each agent with no default row; another agent clears the model and the specialized agent', async () => {
  const { last } = setup(stage({ prompt: '/x', model: 'opus', specializedAgent: 'hive:planner' }));
  expect(menu('modelo')).toHaveTextContent('opus');
  openSelect(screen.getByLabelText(t('settings.stages.agent')));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['claude', 'codex']);
  fireEvent.click(screen.getByRole('option', { name: 'codex' }));
  expect(last()).toMatchObject({ agent: 'codex', model: '', specializedAgent: '' });
  expect(menu('modelo')).toHaveTextContent('padrão do codex');
  expect(menu('agente especializado')).toHaveTextContent('nenhum');
});

test('a picked model and specialized agent are written on the stage', async () => {
  const { user, last } = setup(stage({ prompt: '/x' }));
  await user.click(menu('modelo'));
  await user.click(within(listbox()).getByText('opus'));
  await user.click(menu('agente especializado'));
  await user.click(within(listbox()).getByText('hive:planner'));
  expect(last()).toMatchObject({ model: 'opus', specializedAgent: 'hive:planner' });
});

test('with no lists (no workspace configured yet) a saved skill and specialized agent still show', () => {
  setup(stage({ action: 'skill', skill: 'new-plan', specializedAgent: 'hive:planner' }), undefined);
  expect(menu('skill')).toHaveTextContent('hive:new-plan');
  expect(menu('agente especializado')).toHaveTextContent('hive:planner');
});
