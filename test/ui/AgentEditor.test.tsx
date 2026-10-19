import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// architect.md: header 1–4, `# architect` 5, a chain 9–11 (if 9, endif 11)
const ARCH_TEXT = '---\nname: architect\ndescription: designs\n---\n# architect\n\n## Input\n\n{% if true %}\nRead it.\n{% endif %}\n';
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:architect@': readOf('hive:architect', null, { 'architect.md': ARCH_TEXT }) }, ...extra });
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const savingTo = (saves: SaveBody[]) => (_id: string, body: SaveBody): Response => {
  saves.push(body);
  return json(readOf('hive:architect', 'mine', { [body.path]: body.text }));
};

async function openArchitect(): Promise<void> {
  fireEvent.click(await within(screen.getByRole('navigation', { name: 'Plugins' })).findByRole('button', { name: /^especialistas/ }));
  fireEvent.click(await within(await screen.findByRole('region', { name: 'especialistas' })).findByRole('button', { name: /^architect/ }));
  await waitFor(() => expect(view().model.getValue()).toBe(ARCH_TEXT));
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('a specialist opens its one file with no "+", its map and the toggle; the header stays visible in both modes (#323)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await openArchitect();
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['architect.md']);
  expect(screen.queryByRole('button', { name: 'novo arquivo' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'mapa' })).getByRole('button', { name: 'Input' })).toBeInTheDocument();
  await waitFor(() => expect(view().hiddenAreas).toEqual([{ startLineNumber: 9, endLineNumber: 9 }, { startLineNumber: 11, endLineNumber: 11 }]));
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  await waitFor(() => expect(view().hiddenAreas).toEqual([]));
});

test('⌘S writes the header back; a first {{ x }} saves as architect.md.liquid with the note (#323)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: savingTo(saves) }));
  render(<PluginsWindow />);
  await openArchitect();
  const text = `${ARCH_TEXT}Run in {{ workspace }}.\n`;
  act(() => view().model.type(text));
  act(() => view().onSave());
  expect(await screen.findByRole('status')).toHaveTextContent('renomeado para architect.md.liquid');
  expect(saves).toEqual([{ version: null, path: 'architect.md.liquid', text, from: 'architect.md' }]);
});

test('a header that does not parse, or lacks a description, is not saved and says why (#323)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: savingTo(saves) }));
  render(<PluginsWindow />);
  await openArchitect();
  act(() => view().model.type(ARCH_TEXT.replace('description: designs', 'description: [designs')));
  act(() => view().onSave());
  expect(await screen.findByRole('alert')).toHaveTextContent(/o cabeçalho tem um erro na linha \d/);
  act(() => view().model.type(ARCH_TEXT.replace('description: designs\n', '')));
  act(() => view().onSave());
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('o cabeçalho precisa de description'));
  expect(saves).toEqual([]);
});

test('"view as" previews a specialist read-only, as it does a skill (#323)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await openArchitect();
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await waitFor(() => expect(view().readOnly).toBe(true));
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('architect.md · hive-site');
});
