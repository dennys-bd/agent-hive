import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { DeleteDialog } from '@/components/plugins/DeleteDialog';
import { type MessageKey, setLanguage } from '@/i18n';
import { CATALOGUE, itemOf, OWN, versionOf } from './plugins-fixtures';

afterEach(() => setLanguage('pt'));

// new-build as #dlg-del-version draws it: mine on agent-hive from the plugin's 0.15, tdd-first made from it
const BUILD = itemOf('hive:new-build', { state: 'customized', versions: [versionOf('mine', { workspaces: ['agent-hive'], hiveVersion: '0.15' }), versionOf('tdd-first', { from: 'mine' })] });
const done = async (): Promise<MessageKey | undefined> => undefined;

test('the version dialog names each workspace on it and its fallback, then the version made from it, then that it cannot be undone; excluir deletes and closes, cancelar only closes (#983)', async () => {
  setLanguage('pt');
  const user = userEvent.setup();
  const onDelete = vi.fn(done);
  const onClose = vi.fn();
  const { unmount } = render(<DeleteDialog item={BUILD} items={CATALOGUE} version="mine" isItem={false} onDelete={onDelete} onClose={onClose} />);
  const dialog = await screen.findByRole('alertdialog', { name: 'Excluir mine' });
  expect(dialog).toHaveTextContent('agent-hive usa mine hoje e passa a usar a original da hive 0.15. tdd-first, criada a partir de mine, fica como está. não dá para desfazer.');
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onDelete).toHaveBeenCalledTimes(1);
  unmount();
  const cancelled = vi.fn(done);
  render(<DeleteDialog item={BUILD} items={CATALOGUE} version="mine" isItem={false} onDelete={cancelled} onClose={onClose} />);
  const again = await screen.findByRole('alertdialog', { name: 'Excluir mine' });
  await user.click(within(again).getAllByRole('button', { name: 'cancelar' }).at(-1)!);
  expect([cancelled.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 2]);
});

test('in English, two workspaces and two kept versions read in the plural; a version with neither says only that it cannot be undone (#983)', async () => {
  setLanguage('en');
  const shared = itemOf('hive:new-build', { versions: [versionOf('mine', { workspaces: ['agent-hive', 'hive-site'], hiveVersion: '0.15' }), versionOf('a', { from: 'mine' }), versionOf('b', { from: 'mine' })] });
  const { unmount } = render(<DeleteDialog item={shared} items={CATALOGUE} version="mine" isItem={false} onDelete={done} onClose={vi.fn()} />);
  expect(await screen.findByRole('alertdialog', { name: 'Delete mine' })).toHaveTextContent(
    "agent-hive uses mine today and moves to the hive's original 0.15. hive-site uses mine today and moves to the hive's original 0.15. a, b, made from mine, stay as they are. this cannot be undone.",
  );
  unmount();
  render(<DeleteDialog item={shared} items={CATALOGUE} version="b" isItem={false} onDelete={done} onClose={vi.fn()} />);
  const bare = await screen.findByRole('alertdialog', { name: 'Delete b' });
  expect(within(bare).getByText('this cannot be undone.')).toBeInTheDocument();
  expect(within(bare).getByRole('button', { name: 'delete' })).toBeInTheDocument();
});

test('the item dialog says the item goes from every workspace and names who still calls it, in both languages; with no caller it names none (#983)', async () => {
  setLanguage('pt');
  const { unmount } = render(<DeleteDialog item={OWN} items={CATALOGUE} version="mine" isItem onDelete={done} onClose={vi.fn()} />);
  expect(await screen.findByRole('alertdialog', { name: 'Excluir release-check' })).toHaveTextContent(
    'mine é a última versão, então a skill sai junto, de todos os workspaces. new-spec ainda chama /release-check e o revisor vai acusar isso. não dá para desfazer.',
  );
  unmount();
  setLanguage('en');
  const checker = itemOf('hive:checker', {
    kind: 'specialist', userCreated: true, versions: [versionOf('mine', { from: null })],
    usage: [{ kind: 'stage', stage: 'build' }, { kind: 'caller', id: 'hive:new-spec' }, { kind: 'caller', id: 'hive:new-build' }],
  });
  const second = render(<DeleteDialog item={checker} items={CATALOGUE} version="mine" isItem onDelete={done} onClose={vi.fn()} />);
  expect(await screen.findByRole('alertdialog', { name: 'Delete checker' })).toHaveTextContent(
    'mine is the last version, so the specialist goes with it, from every workspace. new-spec, new-build still call /checker and the reviewer will flag it. this cannot be undone.',
  );
  second.unmount();
  render(<DeleteDialog item={{ ...OWN, usage: [] }} items={CATALOGUE} version="mine" isItem onDelete={done} onClose={vi.fn()} />);
  expect(await screen.findByRole('alertdialog', { name: 'Delete release-check' })).toHaveTextContent(
    'mine is the last version, so the skill goes with it, from every workspace. this cannot be undone.',
  );
});

test('a refused delete keeps the dialog open with its copy inline (#983)', async () => {
  setLanguage('pt');
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<DeleteDialog item={BUILD} items={CATALOGUE} version="mine" isItem={false} onDelete={async () => 'plugins.delete.failed'} onClose={onClose} />);
  const dialog = await screen.findByRole('alertdialog', { name: 'Excluir mine' });
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('não foi possível excluir mine');
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});
