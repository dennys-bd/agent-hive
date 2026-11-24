import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { parseTemplate, type VariableValue } from '../../src/template';
import { addVariable, type EditResult, setVariableValue } from '../../src/template-edit';
import type { WorkspaceVariables } from '../../src/types';
import { VariableForm } from '@/components/plugins/VariableForm';
import { type MessageKey, setLanguage } from '@/i18n';
import { VARS_TEXT } from './plugins-fixtures';

const WORKSPACES = ['agent-hive', 'hive-site'];
const ONLY = 'só neste template';
type Route = (workspace: string, name: string, value: VariableValue | undefined) => Promise<MessageKey | undefined>;

function show(name: string | undefined, values: WorkspaceVariables = {}, answer?: MessageKey) {
  const variable = parseTemplate(VARS_TEXT).variables.find((v) => v.name === name);
  const onApply = vi.fn((_result: EditResult): MessageKey | undefined => undefined);
  const onWorkspaceValue = vi.fn<Route>(async () => answer);
  const onClose = vi.fn();
  render(<VariableForm text={VARS_TEXT} workspaces={WORKSPACES} variable={variable} values={values} onApply={onApply} onWorkspaceValue={onWorkspaceValue} onClose={onClose} />);
  const form = screen.getByRole('form', { name: name === undefined ? '+ variável' : `editar ${name}` });
  return { form, onApply, onWorkspaceValue, onClose };
}
const textOf = (result: EditResult): string => (result.ok ? result.text : `refused: ${result.error.message}`);

beforeEach(() => setLanguage('pt'));

// Kept first: in jsdom a Radix select does not open after an earlier test opened a tooltip or a select
test('a select whose workspace value the declaration does not accept keeps it, red, until an accepted one is picked (#621, decision 3)', async () => {
  const user = userEvent.setup();
  const { form } = show('delivery', { 'agent-hive': { delivery: 'trunk' } });
  const select = within(form).getByRole('combobox', { name: 'agent-hive' });
  expect(select).toHaveTextContent('trunk');
  expect(select).toHaveClass('text-destructive');
  await user.click(select);
  await user.click(await screen.findByRole('option', { name: 'stacked' }));
  expect(within(form).getByRole('combobox', { name: 'agent-hive' })).not.toHaveClass('text-destructive');
});


test('a workspace value field writes through the route and never through applyEdit (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form, onApply, onWorkspaceValue, onClose } = show('testCommand');
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive' }), 'pnpm test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onWorkspaceValue.mock.calls).toEqual([['agent-hive', 'testCommand', 'pnpm test']]);
  expect(onApply).not.toHaveBeenCalled();
});

test('an override field writes through applyEdit and never through the route, and "+ só neste template" moves the focus into its section (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form, onApply, onWorkspaceValue, onClose } = show('testCommand');
  await user.click(within(form).getByRole('button', { name: `+ ${ONLY}` }));
  expect(within(form).getByRole('textbox', { name: `agent-hive · ${ONLY}` })).toHaveFocus();
  await user.keyboard('pnpm t');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls.map(([result]) => textOf(result))).toEqual([textOf(setVariableValue(VARS_TEXT, 'testCommand', 'agent-hive', 'pnpm t'))]);
  expect(onWorkspaceValue).not.toHaveBeenCalled();
});

test('"+ só neste template" shows only when the template has no override; with one the section is open, with its remove link (#621, decision 2)', () => {
  const plain = show('testCommand');
  expect(within(plain.form).getByRole('button', { name: `+ ${ONLY}` })).toBeInTheDocument();
  expect(within(plain.form).queryByRole('group', { name: ONLY })).not.toBeInTheDocument();
  cleanup();
  const overridden = show('delivery');
  expect(within(overridden.form).queryByRole('button', { name: `+ ${ONLY}` })).not.toBeInTheDocument();
  const section = within(overridden.form).getByRole('group', { name: ONLY });
  expect(within(section).getByRole('button', { name: 'remover' })).toBeInTheDocument();
  expect(within(overridden.form).getByRole('group', { name: 'valor por workspace' })).toBeInTheDocument();
});

test('emptying an override removes its header entry; "remover" empties every one and closes the section (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const emptied = show('e2eCommand');
  await user.clear(within(emptied.form).getByRole('textbox', { name: `hive-site · ${ONLY}` }));
  await user.click(within(emptied.form).getByRole('button', { name: 'salvar' }));
  expect(emptied.onApply.mock.calls.map(([result]) => textOf(result))).toEqual([textOf(setVariableValue(VARS_TEXT, 'e2eCommand', 'hive-site', undefined))]);
  cleanup();

  const removed = show('delivery');
  await user.click(within(removed.form).getByRole('button', { name: 'remover' }));
  expect(within(removed.form).queryByRole('group', { name: ONLY })).not.toBeInTheDocument();
  expect(within(removed.form).getByRole('button', { name: `+ ${ONLY}` })).toBeInTheDocument();
  expect(removed.onApply).not.toHaveBeenCalled(); // nothing is written until save
  await user.click(within(removed.form).getByRole('button', { name: 'salvar' }));
  expect(removed.onApply.mock.calls.map(([result]) => textOf(result))).toEqual([textOf(setVariableValue(VARS_TEXT, 'delivery', 'hive-site', undefined))]);
});

test('emptying a workspace value sends the route a removal (DELETE), and an untouched one is not sent (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form, onWorkspaceValue, onApply } = show('testCommand', { 'agent-hive': { testCommand: 'npm test' }, 'hive-site': { testCommand: 'yarn test' } });
  await user.clear(within(form).getByRole('textbox', { name: 'agent-hive' }));
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(onWorkspaceValue.mock.calls).toEqual([['agent-hive', 'testCommand', undefined]]));
  expect(onApply).not.toHaveBeenCalled();
});

test('an empty field shows what it falls back to in italics: the default for a workspace value, the workspace value for an override (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form } = show('testCommand', { 'agent-hive': { testCommand: 'npm test' } });
  expect(within(form).getByRole('textbox', { name: 'hive-site' })).toHaveAttribute('placeholder', 'null');
  await user.click(within(form).getByRole('button', { name: `+ ${ONLY}` }));
  expect(within(form).getByRole('textbox', { name: `agent-hive · ${ONLY}` })).toHaveAttribute('placeholder', 'npm test');
  expect(within(form).getByRole('textbox', { name: `hive-site · ${ONLY}` })).toHaveAttribute('placeholder', 'null');
  expect(within(form).getByRole('textbox', { name: 'hive-site' })).toHaveClass('placeholder:italic');
  cleanup();
  const list = show('delivery').form;
  const empty = within(list).getByRole('combobox', { name: 'agent-hive' });
  expect(empty).toHaveTextContent('single');
  expect(empty).toHaveClass('italic', 'text-muted-foreground');
});

test('the workspace section\'s explanation is the info icon\'s tooltip, naming the variable (#621, decision 2)', async () => {
  const { form } = show('testCommand');
  const section = within(form).getByRole('group', { name: 'valor por workspace' });
  fireEvent.focus(within(section).getByRole('button', { name: 'sobre esta seção' }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('vale para toda skill que declara testCommand. vazio usa o default, o valor em itálico.');
});

test('a refused route write keeps the form open with its copy in the alert line (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form, onClose } = show('testCommand', {}, 'plugins.variables.workspaceValueFailed');
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive' }), 'pnpm test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('O valor do workspace não foi salvo.');
  expect(onClose).not.toHaveBeenCalled();
});

test('a new variable writes its declaration with its overrides first, then each filled workspace value through the route (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const { form, onApply, onWorkspaceValue } = show(undefined);
  await user.type(within(form).getByRole('textbox', { name: 'nome' }), 'reviewer');
  await user.type(within(form).getByRole('textbox', { name: 'hive-site' }), 'x');
  await user.click(within(form).getByRole('button', { name: `+ ${ONLY}` }));
  await user.keyboard('y');
  await user.click(within(form).getByRole('button', { name: 'criar' }));
  await waitFor(() => expect(onWorkspaceValue.mock.calls).toEqual([['hive-site', 'reviewer', 'x']]));
  expect(onApply.mock.calls.map(([result]) => textOf(result))).toEqual([textOf(addVariable(VARS_TEXT, { name: 'reviewer', default: null, workspaces: { 'agent-hive': 'y' } }))]);
  expect(onApply.mock.invocationCallOrder[0]).toBeLessThan(onWorkspaceValue.mock.invocationCallOrder[0] ?? 0);
});
