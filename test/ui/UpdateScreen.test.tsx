import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CatalogueItem, ItemVersion, UpdateConflict, UpdatePreview } from '../../src/types';
import { PluginsView } from '@/components/plugins/PluginsView';
import { usePlugins } from '@/hooks/use-plugins';
import { setLanguage } from '@/i18n';
import { itemOf, json, WORKSPACES } from './plugins-fixtures';

type User = ReturnType<typeof userEvent.setup>;
const updated = (name: string): ItemVersion => ({ name, from: 'original', workspaces: ['agent-hive'], unknownWorkspaces: [], updateAvailable: true, hiveVersion: '0.14' });
const PLAN = itemOf('hive:new-plan', { state: 'update available', versions: [updated('mine')], files: ['SKILL.md', 'reference/index.md'] });
const APPLIED: CatalogueItem = { ...PLAN, state: 'customized', versions: [{ ...updated('mine'), updateAvailable: false }] };
const PATH = '/api/items/hive%3Anew-plan/versions/mine/update';
const CONFLICT: UpdateConflict = {
  kind: 'conflict', id: 'reference/index.md#0', file: 'reference/index.md', heading: '## Index',
  base: ['| # | slice |'], mine: ['| # | slice | owner |'], hive: ['| # | slice | tests |'],
};
const PREVIEW: UpdatePreview = {
  version: 'mine', from: '0.14', to: '0.15', token: 't1',
  changes: [
    { kind: 'clean', file: 'SKILL.md', heading: '## Input', removed: ['Take the issue.'], added: ['Take the issue number.'] },
    { kind: 'clean', file: 'SKILL.md', heading: '## Model routing', removed: ['plan-reviewer: opus'], added: ['plan-reviewer: sonnet', 'tester: haiku'] },
    CONFLICT,
  ],
};
const HIVE = 'new from the hive · 0.15';

interface Answers { catalogue?: CatalogueItem[]; preview?: () => Response; apply?: () => Response }
/** fetch for the view: GET /api/items answers the catalogue, which turns to APPLIED after an apply that answers ok; GET …/update the preview. */
function stubUpdate({ catalogue = [PLAN], preview = () => json(PREVIEW), apply = () => json({}) }: Answers = {}) {
  let items = catalogue;
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/items') return json(items);
    if (init?.method !== 'POST') return preview();
    const answer = apply();
    if (answer.ok) items = [APPLIED];
    return answer;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
type FetchMock = ReturnType<typeof stubUpdate>;
const posts = (mock: FetchMock): { token: string; choices: Record<string, string> }[] =>
  mock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));
const reads = (mock: FetchMock, path: string): number => mock.mock.calls.filter(([p, init]) => p === path && init?.method !== 'POST').length;

// The view as the dock mounts it, outside a header slot provider, so the head renders in place
function View() {
  const plugins = usePlugins(true);
  return (
    <>
      <PluginsView plugins={plugins} workspaces={WORKSPACES} />
      <button type="button" onClick={() => plugins.open({ kind: 'update', id: PLAN.id, version: 'mine' })}>open-update</button>
    </>
  );
}
async function enter(user: User): Promise<void> {
  render(<View />);
  await screen.findByRole('button', { name: /^new-plan/ }); // the catalogue answered
  await user.click(screen.getByRole('button', { name: 'open-update' }));
}
async function openUpdate(user: User): Promise<HTMLElement> {
  await enter(user);
  return screen.findByRole('list', { name: 'changes' });
}
const rows = (list: HTMLElement): HTMLElement[] => within(list).getAllByRole('listitem');
const isOnItem = (): boolean => document.querySelector('[data-plugins-screen]')?.getAttribute('data-plugins-screen') === 'item';

beforeEach(() => setLanguage('en'));
afterEach(() => vi.unstubAllGlobals());

test('the screen heads the item with the versions, titles and sums the update, lists each change with its status and draws the conflict below (#325)', async () => {
  const user = userEvent.setup();
  stubUpdate();
  const list = await openUpdate(user);
  expect(screen.getByText('hive 0.14 → 0.15')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'the hive updated new-plan: 0.14 → 0.15' })).toBeInTheDocument();
  expect(screen.getByText(/^what changed between the old and new original, applied on top of your version\. 2 changes apply cleanly; 1 passage was edited by you and by the hive\.$/)).toBeInTheDocument();
  const [input, routing, index] = rows(list);
  expect(input).toHaveTextContent(/^✓## InputSKILL\.md\+1 −1applied cleanly$/);
  expect(routing).toHaveTextContent(/^✓## Model routingSKILL\.md\+2 −1applied cleanly$/);
  expect(index).toHaveTextContent(/^!## Indexreference\/index\.md\+1 −1choose below$/);
  expect(screen.getByRole('region', { name: 'your version' })).toHaveTextContent('| # | slice | owner |');
  expect(screen.getByRole('region', { name: HIVE })).toHaveTextContent('| # | slice | tests |');
});

test('apply update stays disabled while a conflict has no choice; keep mine enables it, then it posts the token and choices, reads the catalogue again and opens the item, now customized (#325)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate();
  const list = await openUpdate(user);
  const apply = screen.getByRole('button', { name: 'apply update' });
  expect(apply).toBeDisabled();
  expect(screen.getByText('1 conflict left · until then the worker uses your current version')).toHaveClass('text-destructive');
  await user.click(screen.getByRole('button', { name: 'keep mine' }));
  expect(apply).toBeEnabled();
  expect(rows(list)[2]).toHaveTextContent(/keep mine$/);
  expect(screen.getByRole('button', { name: 'keep mine' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('region', { name: HIVE })).toHaveClass('opacity-45');
  expect(screen.queryByText(/conflict left/)).not.toBeInTheDocument();
  await user.click(apply);
  await waitFor(() => expect(screen.getByText('customized')).toBeInTheDocument());
  expect(posts(fetchMock)).toEqual([{ token: 't1', choices: { [CONFLICT.id]: 'mine' } }]);
  expect(reads(fetchMock, '/api/items')).toBe(2);
  expect(isOnItem()).toBe(true);
});

test('later makes no request and opens the item, still update available (#325)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate();
  await openUpdate(user);
  await user.click(screen.getByRole('button', { name: 'later' }));
  expect(isOnItem()).toBe(true);
  expect(screen.getByText('update available')).toBeInTheDocument();
  expect(posts(fetchMock)).toEqual([]);
  expect(reads(fetchMock, '/api/items')).toBe(1);
});

test('a stale apply reads the update again, clears the choice and says so; a failed one keeps the choice in the user\'s words; a gone one opens the item (#325)', async () => {
  const user = userEvent.setup();
  let previews = 0;
  const answers = [json({ error: 'changed', code: 'stale' }, 409), json({ error: 'EACCES' }, 500), json({ error: 'up to date', code: 'no_update' }, 409)];
  const fetchMock = stubUpdate({ preview: () => json({ ...PREVIEW, token: `t${++previews}` }), apply: () => answers.shift() ?? json({}) });
  await openUpdate(user);
  const keepMine = (): HTMLElement => screen.getByRole('button', { name: 'keep mine' });
  const applyButton = (): HTMLElement => screen.getByRole('button', { name: 'apply update' });
  await user.click(keepMine());
  await user.click(applyButton());
  expect(await screen.findByText('the update changed while it was open; review it again')).toHaveAttribute('role', 'alert');
  expect(reads(fetchMock, PATH)).toBe(2);
  expect(keepMine()).toHaveAttribute('aria-pressed', 'false');
  expect(applyButton()).toBeDisabled();
  await user.click(keepMine());
  await user.click(applyButton());
  expect(await screen.findByText('could not apply the update')).toHaveAttribute('role', 'alert');
  expect(screen.queryByText(/EACCES/)).not.toBeInTheDocument();
  expect(keepMine()).toHaveAttribute('aria-pressed', 'true');
  expect(posts(fetchMock).map((body) => body.token)).toEqual(['t1', 't2']);
  await user.click(applyButton());
  await waitFor(() => expect(isOnItem()).toBe(true));
  expect(reads(fetchMock, '/api/items')).toBe(2);
});

test('a side whose file was deleted shows file deleted in its column (#325)', async () => {
  const user = userEvent.setup();
  stubUpdate({ preview: () => json({ ...PREVIEW, changes: [{ ...CONFLICT, hive: null }] }) });
  await openUpdate(user);
  expect(screen.getByRole('region', { name: HIVE })).toHaveTextContent('file deleted');
  expect(screen.getByRole('region', { name: 'your version' })).not.toHaveTextContent('file deleted');
});

test("a failed read says so in the screen, never in the server's words, and offers no apply (#325)", async () => {
  const user = userEvent.setup();
  stubUpdate({ preview: () => json({ error: 'EACCES' }, 500) });
  await enter(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not read the update');
  expect(screen.queryByText(/EACCES/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'apply update' })).not.toBeInTheDocument();
});

test('a read with no update left reads the catalogue again and opens the item (#325)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate({ preview: () => json({ error: 'up to date', code: 'no_update' }, 409) });
  await enter(user);
  await waitFor(() => expect(isOnItem()).toBe(true));
  expect(reads(fetchMock, '/api/items')).toBe(2);
});
