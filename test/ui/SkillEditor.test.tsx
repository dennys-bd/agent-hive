import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseTemplate, renderTemplate } from '../../src/template';
import { moveBlock } from '../../src/template-edit';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { BUILD_TEXT, CATALOGUE, type ItemsServer, json, readOf, type SaveBody, SPEC_TEXT, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT, 'scripts/slice.py': 'print(1)\n' });
const SPEC = readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT });
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD, 'hive:new-spec@': SPEC }, ...extra });
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'mapa' });
const mapRow = (name: string): HTMLElement => within(nav()).getByRole('button', { name }).closest('li')!;
const fileTab = (name: string): HTMLElement => screen.getByRole('tab', { name });
const sidebarItem = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: new RegExp(`^${name}`) });
const dataTransfer = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'move', dropEffect: 'move' };
};
// From the list, as the user does; done once the editor shows the header hidden (visual mode)
async function open(name: string): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('opening new-build shows its files as tabs, its map and its text; another file opens as plain text with no map and no toggle (#319, decision 14)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['SKILL.md.liquid', 'true'], ['scripts/slice.py', 'false']]);
  expect(within(nav()).getByRole('button', { name: 'Stops' })).toBeInTheDocument();
  expect([view().model.getValue(), view().model.language]).toEqual([BUILD_TEXT, 'markdown']);
  fireEvent.click(fileTab('scripts/slice.py'));
  await waitFor(() => expect(view().model.language).toBe('python'));
  expect(screen.getByText('sem mapa para este arquivo')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'modo' })).not.toBeInTheDocument();
});

test("clicking a map block reveals its line; in visual mode a hidden marker lands on the branch's first visible line (#319, decision 19)", async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  fireEvent.click(within(nav()).getByRole('button', { name: 'Stops' }));
  expect(view().position).toEqual({ lineNumber: 20, column: 1 });
  fireEvent.click(within(nav()).getByRole('button', { name: 'else' }));
  expect(view().position).toEqual({ lineNumber: 17, column: 1 });
});

test('dropping a block on its next sibling changes the buffer as moveBlock does: the tab turns dirty and the map follows (#319, decision 20)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  const dt = dataTransfer();
  fireEvent.dragStart(within(mapRow('Input')).getAllByTitle('arrastar')[0]!, { dataTransfer: dt });
  fireEvent.dragOver(mapRow('Stops'), { dataTransfer: dt });
  fireEvent.drop(mapRow('Stops'), { dataTransfer: dt });
  const moved = moveBlock(BUILD_TEXT, 11, 1);
  if (!moved.ok) throw new Error(moved.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(moved.text));
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
  expect(within(nav()).getAllByRole('button').map((b) => b.textContent).filter((text) => text === 'Input' || text === 'Stops')).toEqual(['Stops', 'Input']);
});

test('visual mode hides the header and the markers and shows the chips; text mode shows every line with the markers grey (#319, decisions 15, 17)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(view().hiddenAreas).toEqual([{ startLineNumber: 1, endLineNumber: 6 }, { startLineNumber: 14, endLineNumber: 14 }, { startLineNumber: 16, endLineNumber: 16 }, { startLineNumber: 18, endLineNumber: 18 }]);
  expect(within(screen.getByRole('group', { name: 'condições' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['if delivery == "stacked"', 'else']);
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  await waitFor(() => expect(view().hiddenAreas).toEqual([]));
  expect(view().decorations.filter((d) => d.options.inlineClassName === 'template-marker').map((d) => d.range.startLineNumber)).toEqual([14, 16, 18]);
  expect(screen.getByRole('group', { name: 'condições' })).toBeInTheDocument();
});

test('view as a workspace: read-only, the edit controls gone, the false branch dimmed in the text and the map, the tab SKILL.md · hive-site, and the kept text is the render (#319, decisions 22, 23, 26)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('SKILL.md · hive-site');
  expect(screen.queryByRole('button', { name: 'novo arquivo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'modo' })).not.toBeInTheDocument();
  expect(within(nav()).queryAllByTitle('arrastar')).toEqual([]);
  expect(within(nav()).getByRole('button', { name: 'else' }).closest('.opacity-35')).not.toBeNull();
  const dimmed = new Set(view().decorations.filter((d) => d.options.inlineClassName === 'template-dim').map((d) => d.range.startLineNumber));
  const kept = view().model.getValue().split('\n').filter((_, i) => !dimmed.has(i + 1)).join('\n');
  const rendered = renderTemplate(parseTemplate(BUILD_TEXT), 'hive-site');
  expect(rendered.ok && kept).toBe(rendered.ok && rendered.text);
});

test('⌘S saves the open file to its version and the tab reads clean; a failed save shows its copy and stays dirty (#319, decisions 7, 8)', async () => {
  let refuse = false;
  const saves: SaveBody[] = [];
  const mock = stubItems(serverOf({ save: (_id, body) => {
    saves.push(body);
    return refuse ? json({ error: 'disk' }, 500) : json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text, 'scripts/slice.py': 'print(1)\n' }));
  } }));
  render(<PluginsWindow />);
  await open('new-build');
  act(() => view().model.type(`${BUILD_TEXT}More.\n`));
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
  act(() => view().onSave());
  await waitFor(() => expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'false'));
  expect(saves).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: `${BUILD_TEXT}More.\n` }]);
  expect(mock.mock.calls.filter(([path]) => path === '/api/items')).toHaveLength(2);
  refuse = true;
  act(() => view().model.type('again\n'));
  act(() => view().onSave());
  expect(await screen.findByRole('alert')).toHaveTextContent('não foi possível salvar o arquivo');
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
});

test('a first {{ x }} in SKILL.md saves as SKILL.md.liquid from SKILL.md: the tab takes the name and the note shows (#319, decision 9)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (_id, body) => { saves.push(body); return json(readOf('hive:new-spec', 'mine', { 'SKILL.md.liquid': body.text })); } }));
  render(<PluginsWindow />);
  await open('new-spec');
  const text = `${SPEC_TEXT}Run in {{ workspace }}.\n`;
  act(() => view().model.type(text));
  act(() => view().onSave());
  expect(await screen.findByRole('status')).toHaveTextContent('renomeado para SKILL.md.liquid');
  expect(saves).toEqual([{ version: null, path: 'SKILL.md.liquid', text, from: 'SKILL.md' }]);
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('SKILL.md.liquid');
});

test('edits survive switching to another item and back (#319, decision 6)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  act(() => view().model.type(`${BUILD_TEXT}unsaved\n`));
  fireEvent.click(sidebarItem('new-spec'));
  await waitFor(() => expect(view().model.getValue()).toBe(SPEC_TEXT));
  fireEvent.click(sidebarItem('new-build'));
  await waitFor(() => expect(view().model.getValue()).toBe(`${BUILD_TEXT}unsaved\n`));
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
});
