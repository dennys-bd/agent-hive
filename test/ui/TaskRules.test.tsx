import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskRules } from '@/components/settings/TaskRules';
import { setLanguage, t } from '@/i18n';
import type { SourceTaskPropsDraft, TaskRuleDraft } from '@/lib/setup-source-task-props';
import { RULES_MAX } from '../../src/task-props';
import type { TaskProps } from '../../src/types';

beforeEach(() => setLanguage('pt'));

const rule = (id: string, field: string, value: string, set: Partial<TaskProps>): TaskRuleDraft => ({ id, field, op: 'icontains', value, set });
const draftOf = (rules: TaskRuleDraft[]): SourceTaskPropsDraft => ({ defaults: { workspace: 'api', auto: true }, rules });
const RULES = [rule('a', 'title', '[api]', { workspace: 'api' }), rule('b', 'labels', 'web', { workspace: 'web', auto: false })];

test('each rule reads when / sets; + regra, ↑ / ↓, remover, the value, the condition and ignorar case reach onChange as a new draft (#293, #688)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<TaskRules draft={draftOf(RULES)} workspaces={['api', 'web']} onChange={onChange} />);
  const blocks = screen.getAllByTestId('task-rule');
  expect(within(blocks[0]).getByText('1')).toBeInTheDocument();
  expect(within(blocks[1]).getByText('2')).toBeInTheDocument();
  expect(within(blocks[0]).getByText(t('settings.taskProps.when'))).toBeInTheDocument();
  expect(within(blocks[0]).getByText(t('settings.taskProps.sets'))).toBeInTheDocument();
  expect(within(blocks[0]).getByLabelText('campo')).toHaveValue('title');
  expect(within(blocks[0]).getByLabelText('campo')).toHaveAttribute('placeholder', 'title, labels…');
  expect(within(blocks[0]).getByLabelText('condição')).toHaveTextContent('contém');
  expect(within(blocks[0]).getByRole('switch', { name: 'ignorar case' })).toBeChecked();
  expect(within(blocks[0]).getByRole('button', { name: '↑' })).toBeDisabled();
  expect(within(blocks[1]).getByRole('button', { name: '↓' })).toBeDisabled();
  expect(screen.getByText(t('settings.taskProps.rulesHint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.workspaceRules.fieldHint'))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '+ regra' }));
  // every property is set somewhere: the new rule sets workspace, at the default; its id is fresh, so match its shape
  expect(onChange).toHaveBeenLastCalledWith(draftOf([...RULES, expect.objectContaining({ field: '', op: 'icontains', value: '', set: { workspace: 'api' } })]));
  await user.click(within(blocks[1]).getByRole('button', { name: '↑' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[1], RULES[0]]));
  await user.click(within(blocks[0]).getByRole('button', { name: 'remover' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[1]]));
  await user.type(within(blocks[1]).getByLabelText('valor'), '!');
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[0], { ...RULES[1], value: 'web!' }]));
  fireEvent.click(within(blocks[0]).getByLabelText('condição')); // a plain click opens Radix reliably here, as in StageEditor's tests
  fireEvent.click(await screen.findByRole('option', { name: 'é igual a' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([{ ...RULES[0], op: 'iequals' }, RULES[1]]));
  await user.click(within(blocks[1]).getByRole('switch', { name: 'ignorar case' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[0], { ...RULES[1], op: 'contains' }]));
});

test('a chip per property the rule sets: its value and × reach onChange; + propriedade offers what the rule does not set and hides when it sets all (#688)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<TaskRules draft={draftOf(RULES)} workspaces={['api', 'web']} onChange={onChange} />);
  const blocks = screen.getAllByTestId('task-rule');
  expect(within(blocks[0]).getAllByTestId('task-rule-chip')).toHaveLength(1);
  expect(within(blocks[1]).getAllByTestId('task-rule-chip')).toHaveLength(2);
  expect(within(blocks[1]).queryByRole('button', { name: '+ propriedade' })).not.toBeInTheDocument();
  within(blocks[0]).getByRole('button', { name: '+ propriedade' }).focus(); // Radix's menu opens on a key under jsdom, not on a click; first in the test: after a Select has opened here it does not open
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'auto' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([{ ...RULES[0], set: { workspace: 'api', auto: true } }, RULES[1]]));
  await user.click(within(blocks[1]).getAllByRole('button', { name: 'não definir' })[1]);
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[0], { ...RULES[1], set: { workspace: 'web' } }]));
  fireEvent.click(within(blocks[1]).getByLabelText('workspace'));
  fireEvent.click(await screen.findByRole('option', { name: 'api' }));
  expect(onChange).toHaveBeenLastCalledWith(draftOf([RULES[0], { ...RULES[1], set: { workspace: 'api', auto: false } }]));
});

test('+ regra disables at RULES_MAX; no rules shows no block (#293, #688)', () => {
  const { rerender } = render(<TaskRules draft={draftOf([])} workspaces={['api']} onChange={vi.fn()} />);
  expect(screen.queryAllByTestId('task-rule')).toHaveLength(0);
  expect(screen.getByRole('button', { name: '+ regra' })).toBeEnabled();
  const full = Array.from({ length: RULES_MAX }, (_, i) => rule(String(i), 'title', 'x', { workspace: 'api' }));
  rerender(<TaskRules draft={draftOf(full)} workspaces={['api']} onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: '+ regra' })).toBeDisabled();
});
