import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CatalogueItem, DiffHunk, ItemVersion, UpdateChange, UpdateConflict, UpdatePreview } from '../../src/types';
import { PluginsView } from '@/components/plugins/PluginsView';
import { useAnnotations } from '@/hooks/use-annotations';
import { useItemEditor } from '@/hooks/use-item-editor';
import { usePlugins } from '@/hooks/use-plugins';
import { useProtocol } from '@/hooks/use-protocol';
import { setLanguage } from '@/i18n';
import { itemOf, json, WORKSPACES } from './plugins-fixtures';

type User = ReturnType<typeof userEvent.setup>;
const updated = (name: string): ItemVersion => ({ name, from: 'original', workspaces: ['agent-hive'], unknownWorkspaces: [], updateAvailable: true, hiveVersion: '0.14', editedAt: '2026-10-19T09:00:00.000Z' });
const PLAN = itemOf('hive:new-plan', { state: 'update available', versions: [updated('mine')], files: ['SKILL.md', 'reference/index.md'] });
const APPLIED: CatalogueItem = { ...PLAN, state: 'customized', versions: [{ ...updated('mine'), updateAvailable: false }] };
const PATH = '/api/items/hive%3Anew-plan/versions/mine/update';
const CONFLICT: UpdateConflict = {
  kind: 'conflict', id: 'reference/index.md#0', file: 'reference/index.md', heading: '## Index',
  base: ['| # | slice |'], mine: ['| # | slice | owner |'], hive: ['| # | slice | tests |'],
};
// #984: each clean row's diff, the Hive's original before and after, numbered as the screen's 11d draws them
const INPUT_DIFF: DiffHunk[] = [{
  header: '@@ -8,3 +8,3 @@',
  lines: [
    { kind: 'context', text: '## Input', old: 8, new: 8 }, { kind: 'del', text: 'Take the issue.', old: 9 },
    { kind: 'add', text: 'Take the issue number.', new: 9 }, { kind: 'context', text: 'Stop when none is found.', old: 10, new: 10 },
  ],
}];
const ROUTING_DIFF: DiffHunk[] = [{
  header: '@@ -22,2 +22,3 @@',
  lines: [
    { kind: 'context', text: '## Model routing', old: 22, new: 22 }, { kind: 'del', text: 'plan-reviewer: opus', old: 23 },
    { kind: 'add', text: 'plan-reviewer: sonnet', new: 23 }, { kind: 'add', text: 'tester: haiku', new: 24 },
  ],
}];
const PREVIEW: UpdatePreview = {
  version: 'mine', from: '0.14', to: '0.15', token: 't1',
  changes: [
    { kind: 'clean', file: 'SKILL.md', heading: '## Input', removed: ['Take the issue.'], added: ['Take the issue number.'], diff: INPUT_DIFF },
    { kind: 'clean', file: 'SKILL.md', heading: '## Model routing', removed: ['plan-reviewer: opus'], added: ['plan-reviewer: sonnet', 'tester: haiku'], diff: ROUTING_DIFF },
    CONFLICT,
  ],
};
const HIVE = 'new from the hive';
// #984: a workspace item's update, whose preview has no plugin versions; a binary row, whose diff is empty
const SITE = itemOf('hive-site:deploy', { state: 'update available', versions: [updated('mine')], files: ['SKILL.md'] });
const SITE_PREVIEW: UpdatePreview = { version: 'mine', token: 't1', changes: PREVIEW.changes.slice(0, 1) };
const BINARY: UpdateChange = { kind: 'clean', file: 'logo.png', heading: 'logo.png', removed: [], added: [], diff: [] };

interface Answers { catalogue?: CatalogueItem[]; preview?: () => Response; apply?: () => Response }
/** fetch for the view: GET /api/items answers the catalogue, which turns to APPLIED after an apply that answers ok; GET …/update the preview. */
function stubUpdate({ catalogue = [PLAN], preview = () => json(PREVIEW), apply = () => json({}) }: Answers = {}) {
  let items = catalogue;
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/items') return json({ items });
    if (init?.method === 'DELETE') return json({}); // the head's revert (#492)
    if (!path.endsWith('/update')) return json({ error: 'not stubbed' }, 404); // the editor's read of the item it returns to (#319)
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
function View({ id = PLAN.id }: { id?: string }) {
  const plugins = usePlugins(true);
  const editor = useItemEditor(plugins);
  const annotations = useAnnotations(editor, plugins.items, WORKSPACES);
  const protocol = useProtocol(false);
  return (
    <>
      <PluginsView plugins={plugins} editor={editor} annotations={annotations} protocol={protocol} workspaces={WORKSPACES} fontFamily="monospace" pick={{ agent: 'claude', model: '' }} onPick={() => undefined} />
      <button type="button" onClick={() => plugins.open({ kind: 'update', id, version: 'mine' })}>open-update</button>
    </>
  );
}
async function enter(user: User, id = PLAN.id, name = /^new-plan/): Promise<void> {
  render(<View id={id} />);
  await screen.findByRole('button', { name }); // the catalogue answered
  await user.click(screen.getByRole('button', { name: 'open-update' }));
}
async function openUpdate(user: User): Promise<HTMLElement> {
  await enter(user);
  return screen.findByRole('list', { name: 'changes' });
}
const rows = (list: HTMLElement): HTMLElement[] => within(list).getAllByRole('listitem');
const rowButton = (row: HTMLElement | undefined): HTMLElement => within(row!).getByRole('button');
// #984: each line of an open diff as its number, sign and text
const diffLines = (region: HTMLElement): string[] => Array.from(region.querySelectorAll('[data-mark]'), (line) => line.textContent ?? '');
const isOnItem = (): boolean => document.querySelector('[data-plugins-screen]')?.getAttribute('data-plugins-screen') === 'item';

beforeEach(() => setLanguage('en'));
afterEach(() => vi.unstubAllGlobals());

test('the screen heads the item with the versions, titles and sums the update, lists each change with its status and draws the conflict below (#325)', async () => {
  const user = userEvent.setup();
  stubUpdate();
  const list = await openUpdate(user);
  expect(screen.getByText('hive 0.14 → 0.15').parentElement).toHaveTextContent(/^skills · hive 0\.14 → 0\.15$/);
  expect(screen.getByRole('heading', { name: 'the hive updated new-plan: 0.14 → 0.15' })).toBeInTheDocument();
  expect(screen.getByText(/^what changed between the old and new original, applied on top of your version\. 2 changes apply cleanly; 1 passage was edited by you and by the hive\.$/)).toBeInTheDocument();
  const [input, routing, index] = rows(list);
  expect(input).toHaveTextContent(/^## InputSKILL\.md · \+1 −1applied cleanly$/);
  expect(routing).toHaveTextContent(/^## Model routingSKILL\.md · \+2 −1applied cleanly$/);
  expect(index).toHaveTextContent(/^## Indexreference\/index\.md · \+1 −1choose below$/);
  expect(within(input!).getByText('applied cleanly')).toHaveClass('text-working');
  expect(within(index!).getByText('choose below')).toHaveClass('text-destructive');
  expect(screen.getByRole('region', { name: 'your version' })).toHaveTextContent('| # | slice | owner |');
  expect(screen.getByRole('region', { name: HIVE })).toHaveTextContent('| # | slice | tests |');
});

test('apply update stays disabled while a conflict has no choice; keep mine enables it, then it posts the token and choices, reads the catalogue again and opens the item, now customized (#325)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate();
  const list = await openUpdate(user);
  const apply = screen.getByRole('button', { name: 'apply update' });
  expect([apply.getAttribute('aria-disabled'), apply.hasAttribute('disabled')]).toEqual(['true', false]); // focusable while a conflict waits (#492)
  await user.click(apply);
  expect(posts(fetchMock)).toEqual([]);
  expect(screen.getByText('1 conflict left · until then the worker uses your current version')).toHaveClass('text-muted-foreground');
  await user.click(screen.getByRole('button', { name: 'keep mine' }));
  expect(apply).not.toHaveAttribute('aria-disabled');
  expect(rows(list)[2]).toHaveTextContent(/keep mine$/);
  expect(screen.getByRole('button', { name: 'keep mine' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('region', { name: HIVE })).toHaveClass('opacity-50');
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
  expect(applyButton()).toHaveAttribute('aria-disabled', 'true');
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

test('a stale apply whose re-read fails keeps the preview and the choice made on it (#325)', async () => {
  const user = userEvent.setup();
  let previews = 0;
  stubUpdate({ preview: () => (++previews === 1 ? json(PREVIEW) : json({ error: 'EIO' }, 500)), apply: () => json({ error: 'changed', code: 'stale' }, 409) });
  await openUpdate(user);
  await user.click(screen.getByRole('button', { name: 'keep mine' }));
  await user.click(screen.getByRole('button', { name: 'apply update' }));
  expect(await screen.findByText('could not read the update')).toHaveAttribute('role', 'alert');
  expect(screen.getByRole('button', { name: 'keep mine' })).toHaveAttribute('aria-pressed', 'true');
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

test("an item in update available heads its chip as a button that opens its first updated version's update; one updated version has no select (#325)", async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate();
  render(<View />);
  await user.click(await screen.findByRole('button', { name: /^new-plan/ }));
  await user.click(screen.getByRole('button', { name: 'update available' }));
  expect(await screen.findByText('hive 0.14 → 0.15')).toBeInTheDocument();
  expect(reads(fetchMock, PATH)).toBe(1);
  expect(rows(screen.getByRole('list', { name: 'changes' }))).toHaveLength(3);
  expect(screen.getByRole('region', { name: HIVE })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: /^version/ })).not.toBeInTheDocument();
});

test('with two updated versions the head selects between them, the up-to-date one left out; choosing tdd reads its update (#325)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate({ catalogue: [{ ...PLAN, versions: [updated('mine'), updated('tdd'), { ...updated('old'), updateAvailable: false }] }] });
  render(<View />);
  await user.click(await screen.findByRole('button', { name: /^new-plan/ }));
  await user.click(screen.getByRole('button', { name: 'update available' }));
  await screen.findByText('hive 0.14 → 0.15');
  // the keyboard opens it: in jsdom the mouse click's pointerup lands on the first item and closes the list at once
  screen.getByRole('combobox', { name: 'version: mine' }).focus(); // #492: the label names the open version
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['mine', 'tdd']);
  await user.click(screen.getByRole('option', { name: 'tdd' }));
  await waitFor(() => expect(reads(fetchMock, '/api/items/hive%3Anew-plan/versions/tdd/update')).toBe(1));
});

test('a change with a changelog note shows it in place of its file and counts; the footer has no border, apply then later (#492)', async () => {
  const user = userEvent.setup();
  const [input, ...rest] = PREVIEW.changes;
  stubUpdate({ preview: () => json({ ...PREVIEW, changes: [{ ...input!, note: 'accepts the issue number anywhere' }, ...rest] }) });
  const list = await openUpdate(user);
  const [noted, plain] = rows(list);
  expect(noted).toHaveTextContent(/^## Inputaccepts the issue number anywhereapplied cleanly$/);
  expect(within(noted!).getByText('accepts the issue number anywhere')).toHaveClass('text-soft');
  expect(plain).toHaveTextContent('SKILL.md · +2 −1');
  const footer = document.querySelector('footer')!; // inside the screen's section a footer is no landmark
  expect(footer).not.toHaveClass('border-t');
  expect(within(footer).getAllByRole('button').map((b) => b.textContent)).toEqual(['apply update', 'later']);
});

test("the head's revert asks first, deletes the version, reads the catalogue again and opens the item (#492)", async () => {
  const user = userEvent.setup();
  const fetchMock = stubUpdate();
  await openUpdate(user);
  await user.click(screen.getByRole('button', { name: "revert to the hive's original" }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'revert' }));
  await waitFor(() => expect(isOnItem()).toBe(true));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([path]) => path)).toEqual(['/api/items/hive%3Anew-plan/versions/mine']);
  expect(reads(fetchMock, '/api/items')).toBe(2);
});

test("a clean row is a button that opens the Hive's diff under it, numbered and headed with both plugin versions, the file and the lines; a second click closes it (#984)", async () => {
  const user = userEvent.setup();
  stubUpdate();
  const list = await openUpdate(user);
  const input = rowButton(rows(list)[0]);
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'diff of ## Input' })).not.toBeInTheDocument();
  await user.click(input);
  expect(input).toHaveAttribute('aria-expanded', 'true');
  const region = screen.getByRole('region', { name: 'diff of ## Input' });
  expect(input).toHaveAttribute('aria-controls', region.id);
  expect(rows(list)[0]).toContainElement(region);
  expect(region).toHaveTextContent(/^hive original 0\.14 → 0\.15SKILL\.md · lines 8–10/);
  expect(diffLines(region)).toEqual(['8 ## Input', '9−Take the issue.', '9+Take the issue number.', '10 Stop when none is found.']);
  await user.click(input);
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'diff of ## Input' })).not.toBeInTheDocument();
});

test('in Portuguese the open diff is headed original da hive with linhas, and a binary row opens its one line (#984)', async () => {
  setLanguage('pt');
  const user = userEvent.setup();
  stubUpdate({ preview: () => json({ ...PREVIEW, changes: [...PREVIEW.changes, BINARY] }) });
  await enter(user);
  const list = await screen.findByRole('list', { name: 'mudanças' });
  await user.click(rowButton(rows(list)[1]));
  const routing = screen.getByRole('region', { name: 'diff de ## Model routing' });
  expect(routing).toHaveTextContent(/^original da hive 0\.14 → 0\.15SKILL\.md · linhas 22–24/);
  expect(diffLines(routing)).toEqual(['22 ## Model routing', '23−plan-reviewer: opus', '23+plan-reviewer: sonnet', '24+tester: haiku']);
  await user.click(rowButton(rows(list)[3]));
  expect(screen.getByRole('region', { name: 'diff de logo.png' })).toHaveTextContent(/^arquivo binário, sem diff de texto$/);
});

test.each([
  ['en', 'changes', 'diff of ## Input', /^workspace originalSKILL\.md · lines 8–10/],
  ['pt', 'mudanças', 'diff de ## Input', /^original do workspaceSKILL\.md · linhas 8–10/],
] as const)("in %s a workspace item's open diff is headed by the workspace's original, with no plugin versions (#984)", async (language, listName, regionName, header) => {
  setLanguage(language);
  const user = userEvent.setup();
  stubUpdate({ catalogue: [SITE], preview: () => json(SITE_PREVIEW) });
  await enter(user, SITE.id, /^deploy/);
  const list = await screen.findByRole('list', { name: listName });
  await user.click(rowButton(rows(list)[0]));
  expect(screen.getByRole('region', { name: regionName })).toHaveTextContent(header);
});

test('a binary row opens its one line; a conflict row is no disclosure and its two sides and choices still render below (#984)', async () => {
  const user = userEvent.setup();
  stubUpdate({ preview: () => json({ ...PREVIEW, changes: [BINARY, CONFLICT] }) });
  const list = await openUpdate(user);
  const [binary, conflict] = rows(list);
  await user.click(rowButton(binary));
  expect(screen.getByRole('region', { name: 'diff of logo.png' })).toHaveTextContent(/^binary file, no text diff$/);
  expect(within(conflict!).queryByRole('button')).not.toBeInTheDocument();
  expect(conflict!.querySelector('[aria-expanded]')).toBeNull();
  expect(screen.getByRole('region', { name: 'your version' })).toHaveTextContent('| # | slice | owner |');
  expect(screen.getByRole('button', { name: 'keep mine' })).toHaveAttribute('aria-pressed', 'false');
});
