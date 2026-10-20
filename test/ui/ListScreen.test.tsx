import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ListScreen } from '@/components/plugins/ListScreen';
import { usePlugins } from '@/hooks/use-plugins';
import { setLanguage } from '@/i18n';
import { BASED_ON, itemOf, json, SECOND_ORIGIN, stubFetch, WORKSPACES } from './plugins-fixtures';

function List() {
  const plugins = usePlugins(true);
  return (
    <>
      <button type="button" onClick={() => plugins.setCreating(true)}>new</button>
      <button type="button" onClick={() => plugins.setFilter('hive-site')}>only hive-site</button>
      <ListScreen plugins={plugins} section="skills" workspaces={WORKSPACES} />
      <output data-testid="screen">{JSON.stringify(plugins.screen)}</output>
    </>
  );
}
const groups = (): (string | null)[] => screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const nameField = (): HTMLElement => screen.getByRole('textbox', { name: 'nome da nova skill' });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('each row shows the five columns: name, description, state, usage and the external origin with its repository in the tooltip; groups as the sidebar (#313)', async () => {
  stubFetch();
  render(<List />);
  const row = await screen.findByRole('button', { name: /^new-build/ });
  const cells = Array.from(row.children);
  expect(cells.map((c) => c.textContent)).toEqual(['new-build', 'builds the plan', 'customizada', 'etapa build, chamada por new-spec', '↗ superpowers:executing-plans']);
  expect(cells[4]).toHaveAttribute('title', 'baseada em superpowers:executing-plans · obra/superpowers · MIT');
  expect(Array.from(screen.getByRole('button', { name: /^deploy/ }).children)[3]).toHaveTextContent('—');
  expect(groups()).toEqual(['hive', 'agent-hive', 'hive-site']);
  expect(within(screen.getAllByRole('group')[2] as HTMLElement).getByText('.claude/skills')).toBeInTheDocument();
  expect(within(screen.getAllByRole('group')[0] as HTMLElement).getByText('plugin da hive')).toBeInTheDocument();
});

test('a workspace filter keeps hive and that workspace (#313)', async () => {
  const user = userEvent.setup();
  stubFetch();
  render(<List />);
  await screen.findByRole('button', { name: /^new-build/ });
  await user.click(screen.getByRole('button', { name: 'only hive-site' }));
  expect(groups()).toEqual(['hive', 'hive-site']);
});

test('new: Enter creates under the chosen group and opens the item, a refusal shows its copy, Esc cancels (#313)', async () => {
  const user = userEvent.setup();
  const posts: unknown[] = [];
  stubFetch((body) => {
    posts.push(body);
    const { name, origin = 'hive' } = body as { name: string; origin?: string };
    return name === 'taken' ? json({ error: 'hive already has an item named taken' }, 409) : json(itemOf(`${origin}:${name}`), 201);
  });
  render(<List />);
  await screen.findByRole('button', { name: /^new-build/ });
  await user.click(screen.getByRole('button', { name: 'new' }));
  await user.type(nameField(), 'taken{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('esse nome já existe');
  await user.clear(nameField());
  await user.type(nameField(), 'fresh{Enter}');
  await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('{"kind":"item","id":"hive:fresh"}'));
  expect(posts.at(-1)).toEqual({ kind: 'skill', name: 'fresh' });
  await user.click(screen.getByRole('button', { name: 'new' }));
  await user.click(screen.getByRole('combobox', { name: 'grupo' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  await user.type(nameField(), 'own{Enter}');
  await waitFor(() => expect(posts.at(-1)).toEqual({ kind: 'skill', name: 'own', origin: 'hive-site' }));
  await user.click(screen.getByRole('button', { name: 'new' }));
  await user.type(nameField(), 'gone{Escape}');
  expect(screen.queryByRole('textbox', { name: 'nome da nova skill' })).not.toBeInTheDocument();
  expect(posts).toHaveLength(3);
});

test('a row with two origins names both after one ↗, and its tooltip has a line per origin (#338, decision 12)', async () => {
  stubFetch(undefined, () => [itemOf('hive:planner', { description: 'plans', basedOn: [BASED_ON, SECOND_ORIGIN] })]);
  render(<List />);
  const cells = Array.from((await screen.findByRole('button', { name: /^planner/ })).children);
  expect(cells[4]).toHaveTextContent('↗ superpowers:executing-plans, ecc:planner');
  expect(cells[4]).toHaveAttribute('title', 'baseada em superpowers:executing-plans · obra/superpowers · MIT\nbaseada em ecc:planner · affaan-m/ECC · MIT');
});
