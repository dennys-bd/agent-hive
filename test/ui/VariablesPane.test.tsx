import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { removeVariable, setVariableValue } from '../../src/template-edit';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': VARS_TEXT });
const ORIGINAL = readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL });
const saving = (saves: SaveBody[]) => (_id: string, body: SaveBody): Response => {
  saves.push(body);
  return json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text }));
};
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD, 'hive:new-build@': ORIGINAL }, ...extra });
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const pane = (): HTMLElement => screen.getByRole('list', { name: 'variáveis' });
const row = (name: string): HTMLElement => within(pane()).getByRole('listitem', { name });
const value = (name: string, workspace: string): HTMLElement => within(row(name)).getByTitle(`${name} · ${workspace}`);
async function open(name: string): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
  await waitFor(() => expect(within(row('delivery')).getByText('da hive')).toBeInTheDocument()); // the original is read
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("the open file's variables, each with its origin and a value per workspace: an entry, the default muted, null, missing in red, and a gone workspace's entry dimmed (#321, decisions 10–12)", async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(within(pane()).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['delivery', 'e2eCommand', 'reviewDepth', 'testCommand']);
  expect([value('delivery', 'agent-hive').textContent, value('delivery', 'hive-site').textContent]).toEqual(['single', 'stacked']);
  expect(value('delivery', 'agent-hive')).toHaveClass('text-muted-foreground');
  expect(value('delivery', 'hive-site')).toHaveClass('text-foreground');
  expect(value('e2eCommand', 'agent-hive')).toHaveTextContent('—');
  expect(value('e2eCommand', 'agent-hive')).toHaveClass('text-destructive');
  expect(row('e2eCommand')).toHaveClass('border-destructive/30');
  expect(row('delivery')).not.toHaveClass('border-destructive/30');
  expect(value('testCommand', 'agent-hive')).toHaveTextContent('null');
  expect(within(row('e2eCommand')).getByText('old-site · x').parentElement).toHaveClass('opacity-50');
  expect([within(row('e2eCommand')).getByText('sua'), within(row('testCommand')).getByText('da hive')]).toHaveLength(2);
});

test('a card line names where its value comes from, override, workspace value or default, none for a missing one, and is read only (#621, decision 1)', async () => {
  stubItems(serverOf({ lintInput: { catalogue: [], scripts: [], variables: { 'agent-hive': { testCommand: 'npm test' } }, builtIns: {} } }));
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(value('testCommand', 'agent-hive')).toHaveTextContent('npm test'));
  const sourceOf = (name: string, workspace: string): string | null | undefined => value(name, workspace).nextElementSibling?.textContent;
  expect([sourceOf('delivery', 'hive-site'), sourceOf('delivery', 'agent-hive'), sourceOf('testCommand', 'agent-hive')]).toEqual(['sobrescrita', 'default', 'valor do workspace']);
  expect(value('testCommand', 'agent-hive')).toHaveClass('text-foreground');
  expect(value('e2eCommand', 'agent-hive').nextElementSibling).toBeNull();
  for (const name of ['delivery', 'e2eCommand', 'reviewDepth', 'testCommand']) {
    expect(within(row(name)).queryAllByRole('textbox')).toEqual([]);
    expect(within(row(name)).queryAllByRole('combobox')).toEqual([]);
    expect(within(row(name)).queryAllByRole('checkbox')).toEqual([]);
    expect(within(row(name)).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).not.toContain(`${name} · agent-hive`);
  }
});

test('editing a variable replaces its card with the open form, and cancel brings the card back (#621)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('delivery')).getByRole('button', { name: 'editar delivery' }));
  const form = screen.getByRole('form', { name: 'editar delivery' });
  expect(within(pane()).queryByRole('listitem', { name: 'delivery' })).not.toBeInTheDocument();
  expect(screen.queryByTitle('delivery · agent-hive')).not.toBeInTheDocument();
  expect(pane()).toContainElement(form); // in the card's place, not above the list
  await user.click(within(form).getByRole('button', { name: 'cancelar' }));
  expect(row('delivery')).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'editar delivery' })).not.toBeInTheDocument();
});

test('a required variable with no value for a workspace names it in red; an unused one shows its yellow line (#321, decision 6)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(within(row('e2eCommand')).getByText('falta · sem valor em agent-hive')).toHaveClass('text-destructive');
  expect(within(row('reviewDepth')).getByText('definida e nunca usada')).toHaveClass('text-waiting');
  expect(within(row('delivery')).queryByText(/falta|nunca usada/)).not.toBeInTheDocument();
});

test('a workspace value from the lint input satisfies a required variable: its missing line goes (#621, decision 3)', async () => {
  stubItems(serverOf({ lintInput: { catalogue: [], scripts: [], variables: { 'agent-hive': { e2eCommand: 'pnpm e2e' } }, builtIns: {} } }));
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(within(row('e2eCommand')).queryByText(/falta/)).not.toBeInTheDocument());
});

// Kept ahead of the tests that open a Radix select or dialog: in jsdom a second "ver como" select does not open after one of them
test('view as a workspace switches the editor to its preview and "template" switches back, with the list under the select (#321, decision 4)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(screen.getByText('escolha um workspace para ver o texto como ele recebe.')).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(/^SKILL\.md$/);
  expect(screen.getByRole('radio', { name: 'hive-site' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText(/^variáveis resolvidas .* é o que hive-site recebe\.$/)).toBeInTheDocument();
  expect(value('delivery', 'agent-hive').parentElement).toHaveClass('opacity-40');
  expect(value('delivery', 'hive-site').parentElement).not.toHaveClass('opacity-40');
  await user.click(screen.getByRole('radio', { name: 'template' }));
  await waitFor(() => expect(view().readOnly).toBe(false));
  expect(view().model.getValue()).toBe(VARS_TEXT);
  expect(row('delivery')).toBeInTheDocument();
});

test('an override saved on a clean file goes into the header and saves; on a dirty file it only changes the buffer (#321, decisions 5, 13; #621)', async () => {
  const user = userEvent.setup();
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: saving(saves) }));
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('testCommand')).getByRole('button', { name: 'editar testCommand' }));
  const form = screen.getByRole('form', { name: 'editar testCommand' });
  await user.click(within(form).getByRole('button', { name: '+ só neste template' }));
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive · só neste template' }), 'pnpm test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  const written = setVariableValue(VARS_TEXT, 'testCommand', 'agent-hive', 'pnpm test');
  if (!written.ok) throw new Error(written.error.message);
  await waitFor(() => expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: written.text }]));
  await waitFor(() => expect(value('testCommand', 'agent-hive')).toHaveTextContent('pnpm test'));

  act(() => view().model.type(`${written.text}typed\n`));
  await user.click(within(row('delivery')).getByRole('button', { name: 'editar delivery' }));
  const edit = screen.getByRole('form', { name: 'editar delivery' });
  // the keyboard opens it: after a click whose target unmounted (the card, the form), user-event's next click cannot open a Radix select in jsdom
  within(edit).getByRole('combobox', { name: 'agent-hive · só neste template' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: 'stacked' }));
  await user.click(within(edit).getByRole('button', { name: 'salvar' }));
  const chosen = setVariableValue(`${written.text}typed\n`, 'delivery', 'agent-hive', 'stacked');
  if (!chosen.ok) throw new Error(chosen.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(chosen.text));
  expect(saves).toHaveLength(1);
  expect(screen.getByRole('tab', { name: 'SKILL.md.liquid' })).toHaveAttribute('data-dirty', 'true');
});
test('a used "yours" variable goes after a confirmation naming its lines, an unused one at once; a "from hive" one offers no remove (#321, decisions 8, 9)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf({ save: saving([]) }));
  render(<PluginsWindow />);
  await open('new-build');
  expect(within(row('testCommand')).queryByRole('button', { name: 'remover testCommand' })).not.toBeInTheDocument();
  expect(within(row('delivery')).queryByRole('button', { name: 'remover delivery' })).not.toBeInTheDocument();
  await user.click(within(row('e2eCommand')).getByRole('button', { name: 'remover e2eCommand' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('e2eCommand nas linhas 11');
  await user.click(within(dialog).getByRole('button', { name: 'remover' }));
  const removed = removeVariable(VARS_TEXT, 'e2eCommand');
  if (!removed.ok) throw new Error(removed.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(removed.text));
  expect(within(pane()).queryByRole('listitem', { name: 'e2eCommand' })).not.toBeInTheDocument();

  await user.click(within(row('reviewDepth')).getByRole('button', { name: 'remover reviewDepth' }));
  const unused = removeVariable(removed.text, 'reviewDepth');
  if (!unused.ok) throw new Error(unused.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(unused.text));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('a header that does not parse shows its line in place of the list (#321, decision 22)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  act(() => view().model.type(VARS_TEXT.replace('reviewDepth: { default: full }', 'reviewDepth: { default: 3 }')));
  expect(await screen.findByText('o cabeçalho tem um erro: veja a linha 6')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'variáveis' })).not.toBeInTheDocument();
});

test('a file that is not markdown has no variables (#321, decision 3)', async () => {
  stubItems(serverOf({ reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': VARS_TEXT, 'scripts/slice.py': 'print(1)\n' }), 'hive:new-build@': ORIGINAL } }));
  render(<PluginsWindow />);
  await open('new-build');
  fireEvent.click(screen.getByRole('tab', { name: 'slice.py' }));
  expect(await screen.findByText('nenhuma variável neste arquivo')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'variáveis' })).not.toBeInTheDocument();
});

test("a variable's annotation line reads from the editor's annotations: a dismissed one is gone from its row (#327)", async () => {
  const key = 'SKILL.md.liquid\0unused\0unused variable reviewDepth\0  reviewDepth: { default: full }';
  stubItems(serverOf({ dismissed: { 'hive:new-build@mine': [key] } }));
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(within(row('reviewDepth')).queryByText('definida e nunca usada')).not.toBeInTheDocument());
  expect(within(row('e2eCommand')).getByText('falta · sem valor em agent-hive')).toBeInTheDocument();
});

test('the form\'s workspace value goes through its route and never the template, and the line then names it (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const saves: SaveBody[] = [];
  const puts: [string, string, unknown][] = [];
  const putVariable = (workspace: string, name: string, body: { value: unknown } | undefined): Response => {
    puts.push([workspace, name, body]);
    return json({ variables: body === undefined ? {} : { [name]: body.value } });
  };
  stubItems(serverOf({ save: saving(saves), putVariable }));
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('testCommand')).getByRole('button', { name: 'editar testCommand' }));
  const form = screen.getByRole('form', { name: 'editar testCommand' });
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive' }), 'pnpm test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(puts).toEqual([['agent-hive', 'testCommand', { value: 'pnpm test' }]]));
  await waitFor(() => expect(value('testCommand', 'agent-hive')).toHaveTextContent('pnpm test'));
  expect(within(row('testCommand')).getByText('valor do workspace')).toBeInTheDocument();
  expect(saves).toEqual([]);
});
test('"remover" in the form takes the overrides out through the editor and the line falls back to the workspace value (#621, decision 2)', async () => {
  const user = userEvent.setup();
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: saving(saves), lintInput: { catalogue: [], scripts: [], variables: { 'hive-site': { delivery: 'single' } }, builtIns: {} } }));
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(value('delivery', 'hive-site')).toHaveTextContent('stacked'));
  await user.click(within(row('delivery')).getByRole('button', { name: 'editar delivery' }));
  const form = screen.getByRole('form', { name: 'editar delivery' });
  await user.click(within(form).getByRole('button', { name: 'remover' }));
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  const removed = setVariableValue(VARS_TEXT, 'delivery', 'hive-site', undefined);
  if (!removed.ok) throw new Error(removed.error.message);
  await waitFor(() => expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: removed.text }]));
  await waitFor(() => expect(value('delivery', 'hive-site')).toHaveTextContent('single'));
  expect(value('delivery', 'hive-site').nextElementSibling).toHaveTextContent('valor do workspace');
});
test('a workspace value this template cannot take is red on its line and tints the card, with the values it accepts in the lint line (#621, decision 3)', async () => {
  stubItems(serverOf({ lintInput: { catalogue: [], scripts: [], variables: { 'agent-hive': { delivery: 'trunk' } }, builtIns: {} } }));
  render(<PluginsWindow />);
  await open('new-build');
  expect(await within(row('delivery')).findByText('fora de stacked, single · agent-hive')).toHaveClass('text-destructive');
  expect(value('delivery', 'agent-hive')).toHaveTextContent('trunk');
  expect(value('delivery', 'agent-hive')).toHaveClass('text-destructive');
  expect(row('delivery')).toHaveClass('border-destructive/30');
});
test('a workspace value the route refuses keeps the form open with its error and the line as it was (#621, decision 2)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf({ putVariable: () => json({ error: 'name: a variable name is …' }, 400) }));
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('testCommand')).getByRole('button', { name: 'editar testCommand' }));
  const form = screen.getByRole('form', { name: 'editar testCommand' });
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive' }), 'pnpm test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('O valor do workspace não foi salvo.');
  await user.click(within(form).getByRole('button', { name: 'cancelar' }));
  expect(value('testCommand', 'agent-hive')).toHaveTextContent('null');
});
