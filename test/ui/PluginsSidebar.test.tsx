import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PluginsSidebar } from '@/components/plugins/PluginsSidebar';
import { usePlugins } from '@/hooks/use-plugins';
import { setLanguage } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { WorkspaceColorsContext } from '@/lib/workspace-color';
import { json, stubFetch, WORKSPACES } from './plugins-fixtures';

function Sidebar({ activate = vi.fn(), isShown = true }: { activate?: (id: PanelId) => void; isShown?: boolean }) {
  const plugins = usePlugins(true);
  return (
    <>
      <PluginsSidebar plugins={plugins} workspaces={WORKSPACES} isShown={isShown} activate={activate} />
      <button type="button" onClick={() => plugins.open({ kind: 'item', id: 'hive:new-build' })}>open-item</button>
      <output data-testid="screen">{JSON.stringify(plugins.screen)}</output>
    </>
  );
}
const Colors = ({ children }: { children: ReactNode }) => <WorkspaceColorsContext.Provider value={{ 'agent-hive': '#112233', 'hive-site': '#445566' }}>{children}</WorkspaceColorsContext.Provider>;
const row = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const openItem = (): void => void fireEvent.click(screen.getByRole('button', { name: 'open-item' })); // the groups show beside an item, never beside the list

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('the four sections with their counts: skills and specialists count the catalogue, mcp and protocol show none (#313)', async () => {
  stubFetch();
  render(<Sidebar />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^skills/ })).toHaveTextContent('skills5'));
  expect(screen.getByRole('button', { name: /^especialistas/ })).toHaveTextContent('especialistas1');
  expect(screen.getByRole('button', { name: 'mcp' })).toHaveTextContent(/^mcp$/);
  expect(screen.getByRole('button', { name: 'protocolo' })).toHaveTextContent(/^protocolo$/);
});

test("the open section's items by origin: hive first, then each workspace with its colour square; each with its state's dot, and 2 ↗ for two versions and an external origin (#313)", async () => {
  stubFetch();
  render(<Colors><Sidebar /></Colors>);
  openItem();
  await screen.findByRole('button', { name: /^new-build/ });
  const groups = screen.getAllByRole('group');
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['hive', 'agent-hive', 'hive-site']);
  expect(groups[1]?.querySelector('span[style]')).toHaveStyle({ backgroundColor: '#112233' });
  expect(row('new-build')).toHaveTextContent('new-build2 ↗');
  expect(within(row('new-build')).getByText('2 ↗')).toHaveAttribute('title', 'baseada em superpowers:executing-plans · obra/superpowers · MIT');
  const dot = (name: string): Element | null => row(name).querySelector('[data-state]');
  expect(dot('new-spec')).toHaveClass('border'); // hollow: the hive original
  expect(dot('new-build')).toHaveClass('bg-review');
  expect(dot('new-plan')).toHaveClass('bg-waiting');
  expect(dot('deploy')).toHaveClass('bg-muted-foreground');
});

test('on the list screen the side shows the four sections only, as the handoff draws 11a: the list itself holds the items (#313)', async () => {
  stubFetch();
  render(<Sidebar />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^skills/ })).toHaveTextContent('skills5'));
  expect(screen.queryAllByRole('group')).toEqual([]);
  openItem();
  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['hive', 'agent-hive', 'hive-site']);
});

test('typing filters the items by name or description; Ctrl+F opens the side and focuses the search, only while the view is shown (#313)', async () => {
  const user = userEvent.setup();
  stubFetch();
  const activate = vi.fn();
  const { rerender } = render(<Sidebar activate={activate} />);
  openItem();
  await screen.findByRole('button', { name: /^new-build/ });
  await user.type(screen.getByRole('searchbox', { name: 'buscar' }), 'preview');
  expect(screen.queryByRole('button', { name: /^new-build/ })).not.toBeInTheDocument();
  expect(row('deploy')).toBeInTheDocument();
  screen.getByRole('searchbox', { name: 'buscar' }).blur();
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
  expect(activate).toHaveBeenCalledWith('plugins');
  expect(screen.getByRole('searchbox', { name: 'buscar' })).toHaveFocus();
  rerender(<Sidebar activate={activate} isShown={false} />);
  screen.getByRole('searchbox', { name: 'buscar' }).blur();
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
  expect(activate).toHaveBeenCalledTimes(1);
});

test('a section opens its screen and an item its own, marked; the legend lists the four states (#313)', async () => {
  const user = userEvent.setup();
  stubFetch();
  render(<Sidebar />);
  openItem(); // items show only beside an open item, so another one is picked from there
  await user.click(await screen.findByRole('button', { name: /^new-plan/ }));
  expect(screen.getByTestId('screen')).toHaveTextContent('{"kind":"item","id":"hive:new-plan"}');
  expect(row('new-plan')).toHaveAttribute('aria-current', 'true');
  await user.click(screen.getByRole('button', { name: /^especialistas/ }));
  expect(screen.getByTestId('screen')).toHaveTextContent('{"kind":"list","section":"specialists"}');
  await user.click(screen.getByRole('button', { name: 'mcp' }));
  expect(screen.getByTestId('screen')).toHaveTextContent('{"kind":"mcp"}');
  expect(within(screen.getByRole('list', { name: 'estados' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['original da hive', 'customizada', 'atualização disponível', 'do workspace']);
});

test("a failed read says so in the sidebar, in the user's language, never in the server's words (#313)", async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'EACCES' }, 500)));
  render(<Sidebar />);
  expect(await screen.findByRole('alert')).toHaveTextContent('não foi possível ler os plugins; veja o hive.log');
  expect(screen.queryByText(/EACCES/)).not.toBeInTheDocument();
});
