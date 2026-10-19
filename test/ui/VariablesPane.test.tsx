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
const value = (name: string, workspace: string): HTMLElement => within(row(name)).getByLabelText(`${name} · ${workspace}`);
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
  expect(value('e2eCommand', 'agent-hive')).toHaveTextContent('faltando');
  expect(value('e2eCommand', 'agent-hive')).toHaveClass('text-destructive');
  expect(value('testCommand', 'agent-hive')).toHaveTextContent('null');
  expect(within(row('e2eCommand')).getByText('old-site · x').parentElement).toHaveClass('opacity-50');
  expect([within(row('e2eCommand')).getByText('sua'), within(row('testCommand')).getByText('da hive')]).toHaveLength(2);
});

test('a required variable with no value for a workspace names it in red; an unused one shows its yellow line (#321, decision 6)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(within(row('e2eCommand')).getByText('falta · sem valor em agent-hive')).toHaveClass('text-destructive');
  expect(within(row('reviewDepth')).getByText('definida e nunca usada')).toHaveClass('text-waiting');
  expect(within(row('delivery')).queryByText(/falta|nunca usada/)).not.toBeInTheDocument();
});

// Kept ahead of the tests that open a Radix select or dialog: in jsdom a second "ver como" select does not open after one of them
test('view as a workspace switches the editor to its preview and "template" switches back, with the list under the select (#321, decision 4)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('SKILL.md · hive-site');
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'template' }));
  await waitFor(() => expect(view().readOnly).toBe(false));
  expect(view().model.getValue()).toBe(VARS_TEXT);
  expect(row('delivery')).toBeInTheDocument();
});

test('a value written on a clean file goes into the header and saves; on a dirty file it only changes the buffer (#321, decisions 5, 13)', async () => {
  const user = userEvent.setup();
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: saving(saves) }));
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(value('testCommand', 'agent-hive'));
  await user.type(within(row('testCommand')).getByRole('textbox', { name: 'testCommand · agent-hive' }), 'pnpm test{Enter}');
  const written = setVariableValue(VARS_TEXT, 'testCommand', 'agent-hive', 'pnpm test');
  if (!written.ok) throw new Error(written.error.message);
  await waitFor(() => expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: written.text }]));
  await waitFor(() => expect(value('testCommand', 'agent-hive')).toHaveTextContent('pnpm test'));

  act(() => view().model.type(`${written.text}typed\n`));
  await user.click(value('delivery', 'agent-hive'));
  await user.click(await screen.findByRole('option', { name: 'stacked' }));
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
  expect(within(row('testCommand')).queryByRole('button', { name: 'remover' })).not.toBeInTheDocument();
  expect(within(row('delivery')).queryByRole('button', { name: 'remover' })).not.toBeInTheDocument();
  await user.click(within(row('e2eCommand')).getByRole('button', { name: 'remover' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('e2eCommand nas linhas 11');
  await user.click(within(dialog).getByRole('button', { name: 'remover' }));
  const removed = removeVariable(VARS_TEXT, 'e2eCommand');
  if (!removed.ok) throw new Error(removed.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(removed.text));
  expect(within(pane()).queryByRole('listitem', { name: 'e2eCommand' })).not.toBeInTheDocument();

  await user.click(within(row('reviewDepth')).getByRole('button', { name: 'remover' }));
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
  fireEvent.click(screen.getByRole('tab', { name: 'scripts/slice.py' }));
  expect(await screen.findByText('nenhuma variável neste arquivo')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'variáveis' })).not.toBeInTheDocument();
});
