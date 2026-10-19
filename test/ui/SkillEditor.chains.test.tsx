import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, readOf, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// A list, a yes/no and a text variable; agent-hive takes delivery's default, hive-site stacked (#322)
const CHAIN_TEXT = [
  '---',
  'name: new-build',
  'variables:',
  '  delivery: { values: [pr, stacked, x], default: pr, workspaces: { hive-site: stacked } }',
  '  quick: { type: boolean, workspaces: { agent-hive: true } }',
  '  testCommand: { default: null }',
  '---',
  '# new-build',
  '',
  '## Input', // 10
  '{% if delivery == "pr" %}', // 11
  'One PR.',
  '{% elsif delivery == "stacked" %}', // 13
  'Stacked PRs.',
  '{% else %}', // 15
  'Other.',
  '{% endif %}', // 17
  '{% unless quick %}', // 18
  'Review it.',
  '{% endunless %}', // 20
  '',
  '## Stops', // 22
  '',
  'Stop at the end.',
  '',
].join('\n');
const serverOf = (): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': CHAIN_TEXT }) } });
// Each case drives Radix selects through user-event: slow under the parallel gate
const SLOW_MS = 30_000;
const PLUS = 'inserir bloco condicional aqui';
const CARD = 'novo bloco condicional';
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const lines = (): string[] => view().model.getValue().split('\n');
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'mapa' });
const plusBefore = (name: string): HTMLElement => within(within(nav()).getByRole('button', { name }).closest('li')!).getAllByRole('button', { name: PLUS })[0]!;
const chip = (label: string): HTMLElement => within(screen.getByRole('group', { name: 'condições' })).getByRole('button', { name: label });
const block = (scope: HTMLElement, name: string): HTMLElement => within(scope).getByRole('group', { name });
async function choose(user: UserEvent, scope: HTMLElement, label: string, option: string, index = 0): Promise<void> {
  await user.click(within(scope).getAllByRole('combobox', { name: label })[index]!);
  await user.click(await screen.findByRole('option', { name: option }));
}
async function open(): Promise<void> {
  stubItems(serverOf());
  render(<PluginsWindow />);
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-build/ }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}
async function ok(user: UserEvent, dialog: HTMLElement): Promise<void> {
  await user.click(within(dialog).getByRole('button', { name: 'ok' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('inserting an if / else if / else on delivery from the "+" before a block writes its markers at that line; the tab turns dirty and the map shows a row per conditional block (#322, decisions 10–12)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(plusBefore('Stops'));
  const card = screen.getByRole('region', { name: CARD });
  await choose(user, block(card, 'if'), 'variável', 'delivery');
  await choose(user, block(card, 'if'), 'operador', 'é');
  await choose(user, block(card, 'if'), 'valor', 'pr');
  await user.click(within(card).getByRole('button', { name: '+ else if' }));
  await choose(user, block(card, 'else if'), 'variável', 'delivery');
  await choose(user, block(card, 'else if'), 'operador', 'é');
  await choose(user, block(card, 'else if'), 'valor', 'stacked');
  await user.click(within(card).getByRole('switch', { name: 'else' }));
  await user.click(within(card).getByRole('button', { name: 'inserir' }));
  expect(lines().slice(21, 26)).toEqual(['{% if delivery == "pr" %}', '{% elsif delivery == "stacked" %}', '{% else %}', '{% endif %}', '## Stops']);
  expect(screen.getByRole('tab', { name: 'SKILL.md.liquid' })).toHaveAttribute('data-dirty', 'true');
  expect(screen.queryByRole('region', { name: CARD })).not.toBeInTheDocument();
  const rows = within(nav()).getAllByRole('button', { name: /^(if |else|unless )/ }).map((b) => b.textContent);
  expect(rows).toEqual(['if delivery == "pr"', 'else if delivery == "stacked"', 'else', 'unless quick', 'if delivery == "pr"', 'else if delivery == "stacked"', 'else']);
}, SLOW_MS);

test('the chip opens its chain in the popover; "is one of" with two values and ok writes an or; "remove condition" keeps every block\'s text and drops its markers (#322, decisions 5, 13, 17, 18)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(chip('else'));
  const dialog = await screen.findByRole('dialog', { name: 'bloco condicional' });
  expect(within(dialog).getAllByRole('combobox', { name: 'valor' }).map((c) => c.textContent)).toEqual(['pr', 'stacked']);
  await choose(user, block(dialog, 'if'), 'operador', 'é um de…');
  await user.click(within(block(dialog, 'if')).getByRole('checkbox', { name: 'x' }));
  await ok(user, dialog);
  expect(lines()[10]).toBe('{% if delivery == "pr" or delivery == "x" %}');
  await user.click(chip('if delivery == "pr" or delivery == "x"'));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'remover condição' }));
  expect(lines().slice(9, 14)).toEqual(['## Input', 'One PR.', 'Stacked PRs.', 'Other.', '{% unless quick %}']);
  expect(view().model.getValue()).not.toMatch(/\{% (if|elsif|else|endif)\b/);
}, SLOW_MS);

test('"+ and / or" adds a term on another variable, written with and; switching the connective writes or (#322, decision 4)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(chip('if delivery == "pr"'));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(block(dialog, 'if')).getByRole('button', { name: '+ e / ou' }));
  await choose(user, block(dialog, 'if'), 'variável', 'quick', 1);
  await choose(user, block(dialog, 'if'), 'operador', 'é sim', 1);
  await ok(user, dialog);
  expect(lines()[10]).toBe('{% if delivery == "pr" and quick %}');
  await user.click(chip('if delivery == "pr" and quick'));
  const again = await screen.findByRole('dialog');
  await user.click(within(within(again).getByRole('group', { name: 'conectivo' })).getByRole('button', { name: 'or' }));
  await ok(user, again);
  expect(lines()[10]).toBe('{% if delivery == "pr" or quick %}');
}, SLOW_MS);

test("the operators follow the variable's kind and the value field follows the operator; workspace is offered as a list; a refused value disables insert (#322, decisions 6–8)", async () => {
  const user = userEvent.setup();
  await open();
  await user.click(plusBefore('Stops'));
  const card = screen.getByRole('region', { name: CARD });
  const ifBlock = block(card, 'if');
  const optionsOf = async (label: string): Promise<string[]> => {
    await user.click(within(ifBlock).getByRole('combobox', { name: label }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    await user.keyboard('{Escape}'); // closes the list, not the card
    return names;
  };
  expect(await optionsOf('variável')).toEqual(['delivery', 'quick', 'testCommand', 'workspace']);
  await choose(user, ifBlock, 'variável', 'testCommand');
  expect(await optionsOf('operador')).toEqual(['é', 'não é', 'contém', 'tem valor', 'está vazia']);
  await choose(user, ifBlock, 'operador', 'contém');
  fireEvent.change(within(ifBlock).getByRole('textbox', { name: 'valor' }), { target: { value: 'a {{ b }}' } });
  expect(within(card).getByRole('alert')).toHaveTextContent('um valor não pode ter quebra de linha');
  expect(within(card).getByRole('button', { name: 'inserir' })).toBeDisabled();
  await choose(user, ifBlock, 'variável', 'delivery');
  expect(await optionsOf('operador')).toEqual(['é', 'não é', 'é um de…']);
  await choose(user, ifBlock, 'operador', 'é');
  expect(within(ifBlock).getByRole('combobox', { name: 'valor' })).toBeInTheDocument();
  await choose(user, ifBlock, 'variável', 'quick');
  expect(await optionsOf('operador')).toEqual(['é sim', 'é não']);
  await choose(user, ifBlock, 'operador', 'é não');
  expect([within(ifBlock).queryByRole('combobox', { name: 'valor' }), within(ifBlock).queryByRole('textbox', { name: 'valor' })]).toEqual([null, null]);
  expect(within(card).getByRole('button', { name: 'inserir' })).toBeEnabled();
}, SLOW_MS);

test("\"with today's values\" names under each conditional block the workspaces it reaches, and changes with the draft before ok (#322, decisions 15, 16)", async () => {
  const user = userEvent.setup();
  await open();
  await user.click(chip('if delivery == "pr"'));
  const dialog = await screen.findByRole('dialog');
  const reachOf = (name: string): string => within(block(dialog, name)).getByText(/com os valores de hoje/).textContent ?? '';
  const reach = (): string[] => ['if', 'else if', 'else'].map(reachOf);
  expect(reach()).toEqual(['com os valores de hoje: agent-hive', 'com os valores de hoje: hive-site', 'com os valores de hoje: nenhum workspace']);
  await choose(user, block(dialog, 'if'), 'valor', 'x');
  expect(reach()).toEqual(['com os valores de hoje: nenhum workspace', 'com os valores de hoje: hive-site', 'com os valores de hoje: agent-hive']);
  expect(view().model.getValue()).toBe(CHAIN_TEXT);
}, SLOW_MS);

test('removing an else if whose block holds text keeps the popover open with the message and the text unchanged (#322, decision 17)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(chip('if delivery == "pr"'));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(block(dialog, 'else if')).getByRole('button', { name: 'remover else if' }));
  await user.click(within(dialog).getByRole('button', { name: 'ok' }));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('o bloco condicional da linha 13 tem texto: esvazie-o antes de removê-lo');
  expect(view().model.getValue()).toBe(CHAIN_TEXT);
}, SLOW_MS);

test('a second term on an "is no" first block turns {% unless %} … {% endunless %} into {% if v == false and … %} … {% endif %} (#322, decision 6)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(chip('unless quick'));
  const dialog = await screen.findByRole('dialog');
  expect(within(block(dialog, 'if')).getAllByRole('combobox').map((c) => c.textContent)).toEqual(['quick', 'é não']);
  await user.click(within(block(dialog, 'if')).getByRole('button', { name: '+ e / ou' }));
  await choose(user, block(dialog, 'if'), 'variável', 'delivery', 1);
  await choose(user, block(dialog, 'if'), 'operador', 'é', 1);
  await choose(user, block(dialog, 'if'), 'valor', 'pr');
  await ok(user, dialog);
  expect(lines().slice(17, 20)).toEqual(['{% if quick == false and delivery == "pr" %}', 'Review it.', '{% endif %}']);
}, SLOW_MS);

test('Esc closes the card and the popover without writing; another "+" discards the open card\'s draft; the "+" is gone in the preview (#322, decisions 10, 11, 19)', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(plusBefore('Stops'));
  const card = screen.getByRole('region', { name: CARD });
  await choose(user, block(card, 'if'), 'variável', 'delivery');
  fireEvent.keyDown(card, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: CARD })).not.toBeInTheDocument();
  await user.click(plusBefore('Stops'));
  await choose(user, block(screen.getByRole('region', { name: CARD }), 'if'), 'variável', 'delivery');
  await user.click(plusBefore('Input'));
  expect(screen.getAllByRole('region', { name: CARD })).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: CARD })).getByRole('combobox', { name: 'variável' })).not.toHaveTextContent('delivery');
  await user.click(chip('else'));
  expect(screen.queryByRole('region', { name: CARD })).not.toBeInTheDocument();
  await screen.findByRole('dialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(view().model.getValue()).toBe(CHAIN_TEXT);
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(within(nav()).queryAllByRole('button', { name: PLUS })).toEqual([]);
}, SLOW_MS);
