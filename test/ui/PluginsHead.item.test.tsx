import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { BUILD_TEXT, CATALOGUE, itemOf, type ItemsServer, json, readOf, SPEC_TEXT, stubItems, versionOf } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const TODAY_1431 = new Date(new Date().setHours(14, 31, 0, 0)).toISOString();
const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT }, TODAY_1431);
const ORIGINAL = readOf('hive:new-build', null, { 'SKILL.md': '---\nname: new-build\n---\nThe original.\n' });
const SPEC = readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT });
const DEPLOY = readOf('hive-site:deploy', null, { 'SKILL.md': '---\nname: deploy\n---\nShip.\n' }, TODAY_1431);
const READS = { 'hive:new-build@mine': BUILD, 'hive:new-build@': ORIGINAL, 'hive:new-spec@': SPEC, 'hive-site:deploy@': DEPLOY };
const head = (): HTMLElement => screen.getByTestId('head');
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const revertButton = () => within(head()).queryByRole('button', { name: 'voltar para a original da hive' });
const sidebarItem = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: new RegExp(`^${name}`) });
async function open(name: string): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("the meta names the section and the open file's saved time; test on workspace is disabled, coming soon, on the view-as workspace else the first (#319, decisions 10, 11)", async () => {
  const user = userEvent.setup();
  stubItems({ catalogue: CATALOGUE, reads: READS });
  render(<PluginsWindow />);
  await open('new-build');
  await waitFor(() => expect(head()).toHaveTextContent('skills · salvo 14:31'));
  const testButton = within(head()).getByRole('button', { name: 'testar no workspace agent-hive' });
  expect(testButton).toBeDisabled();
  expect(testButton.parentElement).toHaveAttribute('title', 'em breve');
  expect(within(head()).getByRole('button', { name: /^revisor · / })).toBeInTheDocument();
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  expect(within(head()).getByRole('button', { name: 'testar no workspace hive-site' })).toBeDisabled();
  expect(within(head()).queryByRole('button', { name: /^revisor · / })).not.toBeInTheDocument(); // not drawn under "view as" (#327)
  expect(revertButton()).not.toBeInTheDocument(); // the preview hides it (decision 26)
});

test('revert asks, naming the version, deletes it and shows the original under its chip; an original and a workspace item offer none (#319, decision 12)', async () => {
  const user = userEvent.setup();
  const server: ItemsServer = {
    catalogue: CATALOGUE, reads: READS,
    revert: () => {
      server.catalogue = CATALOGUE.map((i) => (i.id === 'hive:new-build' ? itemOf('hive:new-build') : i));
      return json(itemOf('hive:new-build'));
    },
  };
  const mock = stubItems(server);
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(await within(head()).findByRole('button', { name: 'voltar para a original da hive' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('mine');
  await user.click(within(dialog).getByRole('button', { name: 'voltar' }));
  await waitFor(() => expect(within(head()).getByText('original da hive', { selector: 'span' })).toBeInTheDocument());
  expect(mock.mock.calls.some(([path, init]) => path === '/api/items/hive%3Anew-build/versions/mine' && init?.method === 'DELETE')).toBe(true);
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(/^SKILL\.md$/);
  expect(revertButton()).not.toBeInTheDocument();
  fireEvent.click(sidebarItem('deploy'));
  await waitFor(() => expect(within(head()).getByText('deploy')).toBeInTheDocument());
  expect(revertButton()).not.toBeInTheDocument();
});

test("saving an original makes it customized: the chip and the saved time follow the catalogue read after the save (#319, decisions 5, 7)", async () => {
  const server: ItemsServer = {
    catalogue: CATALOGUE, reads: READS,
    save: (_id, body) => {
      server.catalogue = CATALOGUE.map((i) => (i.id === 'hive:new-spec' ? itemOf('hive:new-spec', { state: 'customized', versions: [versionOf('mine')] }) : i));
      return json(readOf('hive:new-spec', 'mine', { 'SKILL.md': body.text }, TODAY_1431));
    },
  };
  stubItems(server);
  render(<PluginsWindow />);
  await open('new-spec');
  expect(within(head()).getByText('original da hive', { selector: 'span' })).toBeInTheDocument();
  expect(head()).not.toHaveTextContent('salvo');
  act(() => view().model.type(`${SPEC_TEXT}More.\n`));
  act(() => view().onSave());
  await waitFor(() => expect(within(head()).getByText('customizada')).toBeInTheDocument());
  expect(head()).toHaveTextContent('skills · salvo 14:31');
});
