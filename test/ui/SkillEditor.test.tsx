import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseTemplate, renderTemplate } from '../../src/template';
import { moveBlock } from '../../src/template-edit';
import { setLanguage, t } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { BUILD_TEXT, CATALOGUE, type ItemsServer, json, readOf, type SaveBody, SPEC_TEXT, stubItems, VARS_ORIGINAL, VARS_TEXT, withVersion } from './plugins-fixtures';
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
  expect(screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['SKILL.md.liquid', 'true'], ['slice.py', 'false']]);
  expect(within(nav()).getByRole('button', { name: 'Stops' })).toBeInTheDocument();
  expect([view().model.getValue(), view().model.language]).toEqual([BUILD_TEXT, 'markdown']);
  fireEvent.click(fileTab('slice.py'));
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
  fireEvent.click(within(nav()).getByText('senão').closest('[data-line]')!.querySelector('button')!);
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
  const chips = within(screen.getByRole('group', { name: 'condições' })).getAllByRole('button');
  expect(chips.map((b) => b.textContent)).toEqual(['só quando delivery = stacked', 'senão']);
  expect([chips[0]?.classList.contains('font-mono'), chips[0]?.classList.contains('rounded-[5px]')]).toEqual([false, true]); // #492: in sans
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  await waitFor(() => expect(view().hiddenAreas).toEqual([]));
  expect(view().decorations.filter((d) => d.options.inlineClassName === 'template-marker').map((d) => d.range.startLineNumber)).toEqual([14, 16, 18]);
  expect(screen.getByRole('group', { name: 'condições' })).toBeInTheDocument();
});

test('view as a workspace: read-only, the edit controls gone, the false branch dimmed in the text and the map, the tab SKILL.md, and the kept text is the render (#319, decisions 22, 23, 26)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(screen.getByRole('radio', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(/^SKILL\.md$/);
  act(() => view().setPosition({ lineNumber: 12, column: 1 }));
  expect(nav().querySelector('[data-current]')).toBeNull(); // #492: the preview raises no block
  expect(screen.queryByRole('button', { name: 'novo arquivo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'modo' })).not.toBeInTheDocument();
  expect(within(nav()).queryAllByTitle('arrastar')).toEqual([]);
  expect(within(nav()).getByText('senão').closest('.opacity-35')).not.toBeNull();
  const dimmed = new Set(view().decorations.filter((d) => d.options.inlineClassName === 'template-dim').map((d) => d.range.startLineNumber));
  const kept = view().model.getValue().split('\n').filter((_, i) => !dimmed.has(i + 1)).join('\n');
  const rendered = renderTemplate(parseTemplate(BUILD_TEXT), { name: 'hive-site', variables: {} });
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
  act(() => view().model.type(`${BUILD_TEXT}again\n`));
  act(() => view().onSave());
  expect(await screen.findByRole('alert')).toHaveTextContent('não foi possível salvar o arquivo');
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
});

test('a first {{ x }} in SKILL.md saves as SKILL.md.liquid from SKILL.md: the tab takes the name and the note shows (#319, decision 9)', async () => {
  const saves: SaveBody[] = [];
  const server: ItemsServer = serverOf({ save: (id, body) => {
    saves.push(body);
    server.catalogue = withVersion(server.catalogue, id, 'mine'); // the store made mine: GET /api/items lists it
    return json(readOf('hive:new-spec', 'mine', { 'SKILL.md.liquid': body.text }));
  } });
  stubItems(server);
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

test('the caret raises its block on the map (#492)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  const current = (): (string | null)[] => Array.from(nav().querySelectorAll('[data-current="true"]')).map((row) => row.getAttribute('data-line'));
  act(() => view().setPosition({ lineNumber: 12, column: 1 }));
  expect(current()).toEqual(['11']);
  act(() => view().setPosition({ lineNumber: 17, column: 1 }));
  expect(current()).toEqual(['16']);
});

// VARS_TEXT with e2eCommand valued everywhere: one annotation left, reviewDepth unused on header line 6, shown at line 10 in visual mode;
// the chain's chip sits at line 12
const ONE_VARS = VARS_TEXT.replace('{ hive-site: pnpm e2e,', '{ agent-hive: pnpm e2e, hive-site: pnpm e2e,');
const VARS_READS = { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': ONE_VARS }), 'hive:new-build@': readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL }) };
const HEADLINE = 'variável não usada reviewDepth';
const marginSwitch = (): HTMLElement => screen.getByRole('switch', { name: 'margem das anotações' });

test('the switch closes the margin, leaving a dot on the annotated line; a click on the dot reopens it with that card open; under ver como there is no switch (#980)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf({ reads: VARS_READS }));
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(marginSwitch()).toHaveAttribute('aria-checked', 'true'));
  fireEvent.click(marginSwitch());
  expect([marginSwitch().getAttribute('aria-checked'), marginSwitch().textContent]).toEqual(['false', 'anotações· 1']);
  expect(screen.queryByRole('group', { name: 'anotações' })).not.toBeInTheDocument();
  await waitFor(() => expect(view().decorations.filter((d) => d.options.glyphMarginClassName === 'template-glyph-yellow').map((d) => d.range.startLineNumber)).toEqual([10]));
  act(() => view().clickGlyph(10));
  expect(marginSwitch()).toHaveAttribute('aria-checked', 'true');
  expect(within(screen.getByRole('group', { name: 'anotações' })).getByRole('article', { name: HEADLINE })).toHaveAttribute('data-open', 'true');
  expect(view().position).toEqual({ lineNumber: 10, column: 1 });
  await user.click(screen.getByRole('radio', { name: 'hive-site' }));
  expect(screen.queryByRole('switch', { name: 'margem das anotações' })).not.toBeInTheDocument();
});

test('a margin reopened with a card still open places that card from the column it just mounted, not from a height of 0 (#980)', async () => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(2000); // the margin column, room for the card below its line
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150); // the open card, measured
  try {
    stubItems(serverOf({ reads: VARS_READS }));
    render(<PluginsWindow />);
    await open('new-build');
    await waitFor(() => expect(marginSwitch()).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(screen.getByRole('group', { name: 'anotações' })).getByRole('button', { name: /reviewDepth/ }));
    fireEvent.click(marginSwitch());
    fireEvent.click(marginSwitch()); // back on with the card still open, nothing else re-rendering the text
    const card = within(screen.getByRole('group', { name: 'anotações' })).getByRole('article', { name: HEADLINE });
    await waitFor(() => expect([card.style.top !== '', card.style.bottom]).toEqual([true, '']));
  } finally { vi.restoreAllMocks(); }
});

test("closing the margin closes an open chip's popover with it; it stays closed when the margin comes back (#980)", async () => {
  stubItems(serverOf({ reads: VARS_READS }));
  render(<PluginsWindow />);
  await open('new-build');
  fireEvent.click(within(screen.getByRole('group', { name: 'condições' })).getAllByRole('button')[0]!);
  expect(await screen.findByRole('dialog', { name: t('plugins.chain.popover') })).toBeInTheDocument();
  fireEvent.click(marginSwitch());
  fireEvent.click(marginSwitch());
  expect(screen.queryByRole('dialog', { name: t('plugins.chain.popover') })).not.toBeInTheDocument();
});
