import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { addVariable, updateVariable } from '../../src/template-edit';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, json, readOf, type SaveBody, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': VARS_TEXT });
const ORIGINAL = readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL });
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const pane = (): HTMLElement => screen.getByRole('list', { name: 'variáveis' });
const row = (name: string): HTMLElement => within(pane()).getByRole('listitem', { name });
function serve(): SaveBody[] {
  const saves: SaveBody[] = [];
  stubItems({
    catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD, 'hive:new-build@': ORIGINAL },
    save: (_id, body) => { saves.push(body); return json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text })); },
  });
  return saves;
}
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

test('"+ variable" with a list type and two values writes a valid declaration: the variable joins the list as yours, and {{ name }} typed in the text is a pill (#321, decision 14)', async () => {
  const user = userEvent.setup();
  const saves = serve();
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(screen.getByRole('button', { name: '+ variável' }));
  const form = screen.getByRole('form', { name: '+ variável' });
  await user.type(within(form).getByRole('textbox', { name: 'nome' }), 'reviewer');
  await user.click(within(form).getByRole('button', { name: 'lista' }));
  await user.type(within(form).getByRole('textbox', { name: 'valores, um por linha' }), 'fast{Enter}deep');
  await user.click(within(form).getByRole('combobox', { name: 'default' }));
  await user.click(await screen.findByRole('option', { name: 'fast' }));
  await user.click(within(form).getByRole('combobox', { name: 'hive-site' }));
  await user.click(await screen.findByRole('option', { name: 'deep' }));
  await user.click(within(form).getByRole('button', { name: 'criar' }));
  const added = addVariable(VARS_TEXT, { name: 'reviewer', values: ['fast', 'deep'], default: 'fast', workspaces: { 'hive-site': 'deep' } });
  if (!added.ok) throw new Error(added.error.message);
  await waitFor(() => expect(saves.at(-1)?.text).toBe(added.text));
  expect(screen.queryByRole('form', { name: '+ variável' })).not.toBeInTheDocument();
  expect(within(row('reviewer')).getByText('sua')).toBeInTheDocument();
  // line 16: the header grew by one line, and the typed line follows the text's final newline
  act(() => view().model.type(`${added.text}Ask {{ reviewer }}.\n`));
  await waitFor(() => expect(view().decorations.some((d) => d.options.inlineClassName === 'template-pill' && d.range.startLineNumber === 16)).toBe(true));
});

test('a name already declared, or workspace, shows its copy in the form and writes nothing (#321, decision 15)', async () => {
  const user = userEvent.setup();
  const saves = serve();
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(screen.getByRole('button', { name: '+ variável' }));
  const form = screen.getByRole('form', { name: '+ variável' });
  const name = within(form).getByRole('textbox', { name: 'nome' });
  await user.type(name, 'delivery');
  await user.click(within(form).getByRole('button', { name: 'criar' }));
  expect(within(form).getByRole('alert')).toHaveTextContent('esse nome já está declarado');
  await user.clear(name);
  await user.type(name, 'workspace');
  await user.click(within(form).getByRole('button', { name: 'criar' }));
  expect(within(form).getByRole('alert')).toHaveTextContent('um nome é uma letra ou _ seguida de letras, dígitos ou _, e não workspace');
  expect([view().model.getValue(), saves]).toEqual([VARS_TEXT, []]);
});

test("edit opens the form on a variable with its name read-only and rewrites the declaration in place, keeping a gone workspace's entry (#321, decisions 7, 11)", async () => {
  const user = userEvent.setup();
  const saves = serve();
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('e2eCommand')).getByRole('button', { name: 'editar' }));
  const form = screen.getByRole('form', { name: 'editar e2eCommand' });
  expect(within(form).getByRole('textbox', { name: 'nome' })).toHaveAttribute('readonly');
  expect(within(form).getByRole('switch', { name: 'obrigatória' })).toBeChecked();
  expect(within(form).getByRole('textbox', { name: 'hive-site' })).toHaveValue('pnpm e2e');
  await user.type(within(form).getByRole('textbox', { name: 'agent-hive' }), 'npx playwright test');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  const updated = updateVariable(VARS_TEXT, 'e2eCommand', { required: true, workspaces: { 'agent-hive': 'npx playwright test', 'hive-site': 'pnpm e2e' } });
  if (!updated.ok) throw new Error(updated.error.message);
  await waitFor(() => expect(saves.at(-1)?.text).toBe(updated.text));
  expect(updated.parsed.variables.find((v) => v.name === 'e2eCommand')?.workspaces).toEqual({ 'agent-hive': 'npx playwright test', 'hive-site': 'pnpm e2e', 'old-site': 'x' });
  expect(updated.text.split('\n')[4]).toMatch(/^ {2}e2eCommand: \{ required: true, workspaces: \{ /);
  expect(screen.queryByRole('form', { name: 'editar e2eCommand' })).not.toBeInTheDocument();
});

test('emptying a workspace in the edit form removes its entry, so the default applies (#321, decision 14)', async () => {
  const user = userEvent.setup();
  const saves = serve();
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(within(row('delivery')).getByRole('button', { name: 'editar' }));
  const form = screen.getByRole('form', { name: 'editar delivery' });
  await user.click(within(form).getByRole('combobox', { name: 'hive-site' }));
  await user.click(await screen.findByRole('option', { name: 'default' }));
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(saves).toHaveLength(1));
  const declaration = saves[0]?.text.split('\n')[3] ?? '';
  expect(declaration).toMatch(/^ {2}delivery: \{ values: .*default: single \}$/); // no workspaces: left behind, not even {}
  expect(declaration).not.toMatch(/hive-site/);
});
