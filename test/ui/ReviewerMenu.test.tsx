import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentAnnotation } from '../../src/reviewer';
import { REVIEWER_DEFAULTS, type ReviewerConfig } from '../../src/types';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { ReviewerMenu } from '@/components/plugins/ReviewerMenu';
import type { Annotations } from '@/hooks/use-annotations';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// VARS_TEXT with e2eCommand valued in every workspace: one lint annotation, reviewDepth unused on line 6 (annotations.test.tsx's ONE_VARS)
const ONE_VARS = VARS_TEXT.replace('{ hive-site: pnpm e2e,', '{ agent-hive: pnpm e2e, hive-site: pnpm e2e,');
const ON_RUN: AgentAnnotation = { line: 11, severity: 'yellow', title: 'the commands run in no stated order', body: 'say whether the tests wait for e2e', source: 'agent' };
const ON_DEPTH: AgentAnnotation = { line: 6, severity: 'yellow', title: 'reviewDepth reads like a level', body: 'name its values', source: 'agent' };
const SAVED: ReviewerConfig = { ...REVIEWER_DEFAULTS, when: 'demand', version: 'strict' };
const echo = (_id: string, body: SaveBody): Response => json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text }));
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({
  catalogue: CATALOGUE,
  reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': ONE_VARS }), 'hive:new-build@': readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL }) },
  save: echo, reviewer: SAVED, review: () => json({ annotations: [ON_RUN] }),
  ...extra,
});
const head = (): HTMLElement => screen.getByTestId('head');
const counter = (name: string): HTMLElement => within(head()).getByRole('button', { name });
const chevron = (): HTMLElement => within(head()).getByRole('button', { name: 'menu do revisor' });
const menu = (): HTMLElement => screen.getByRole('dialog');
const margin = (): HTMLElement => screen.getByRole('group', { name: 'anotações' });
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const reviews = (mock: ReturnType<typeof stubItems>): number => mock.mock.calls.filter(([path]) => String(path).endsWith('/review')).length;
async function open(): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-build/ }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(chevron());
  await screen.findByRole('switch', { name: 'revisor' });
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('turned off: the counter reads "reviewer off · 1 annotation", muted and still jumping, with only the lint\'s; a save posts no review (#329)', async () => {
  const user = userEvent.setup();
  const saves: SaveBody[] = [];
  const server = serverOf({ reviewer: { ...SAVED, when: 'save' }, save: (id, body) => { saves.push(body); return echo(id, body); } });
  const mock = stubItems(server);
  render(<PluginsWindow server={server} />);
  await open();
  await openMenu(user);
  await user.click(screen.getByRole('button', { name: 'revisar agora' }));
  await waitFor(() => expect(counter('revisor · 2 anotações')).toBeEnabled());
  await user.click(screen.getByRole('switch', { name: 'revisor' }));
  await waitFor(() => expect(counter('revisor desligado · 1 anotação')).toHaveClass('text-muted-foreground'));
  expect(counter('revisor desligado · 1 anotação')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'revisar agora' })).toBeDisabled();
  await user.keyboard('{Escape}');
  act(() => view().model.type(`${ONE_VARS}More.\n`));
  act(() => view().onSave());
  await waitFor(() => expect(saves).toHaveLength(1));
  await act(async () => undefined); // the saved read lands, and the watch of the saved text runs
  expect(reviews(mock)).toBe(1);
});

test('a run reads "reviewer · reviewing…" and disables review now; a failure shows its line in the menu and a red dot on ⌄, the next success clears both; Esc closes the menu (#329)', async () => {
  const user = userEvent.setup();
  let release: (response: Response) => void = () => undefined;
  const replies: (() => Response | Promise<Response>)[] = [
    () => new Promise<Response>((resolve) => { release = resolve; }),
    () => json({ annotations: [ON_RUN] }),
  ];
  const server = serverOf({ review: () => (replies.shift() ?? (() => json({ annotations: [] })))() });
  stubItems(server);
  render(<PluginsWindow server={server} />);
  await open();
  await openMenu(user);
  await user.click(screen.getByRole('button', { name: 'revisar agora' }));
  expect(counter('revisor · revisando…')).toBeEnabled(); // the lint's annotation: it still jumps
  expect(screen.getByRole('button', { name: 'revisar agora' })).toBeDisabled();
  await act(async () => { release(json({ error: "the reviewer's answer was refused; see hive.log", code: 'bad_answer' }, 502)); });
  expect(await within(menu()).findByRole('alert')).toHaveTextContent('a resposta do revisor foi recusada; veja o hive.log');
  expect(chevron()).toHaveAttribute('data-error', 'true');
  await user.click(screen.getByRole('button', { name: 'revisar agora' }));
  await waitFor(() => expect(counter('revisor · 2 anotações')).toBeInTheDocument());
  expect(within(menu()).queryByRole('alert')).not.toBeInTheDocument();
  expect(chevron()).toHaveAttribute('data-error', 'false');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('switch', { name: 'revisor' })).not.toBeInTheDocument());
});

test('"reviews", the switch and the agent each post { prefix, reviewer } with only that field changed; a refused post shows "reviewer setting not saved" and keeps the old values (#329)', async () => {
  const user = userEvent.setup();
  const bodies: unknown[] = [];
  let isRefused = false;
  const server = serverOf({ postSettings: (body) => { bodies.push(body); return isRefused ? json({ error: 'disk full' }, 500) : json({ ok: true }); } });
  stubItems(server);
  render(<PluginsWindow server={server} />);
  await open();
  await openMenu(user);
  await user.click(screen.getByRole('radio', { name: 'ao salvar' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'ao salvar' })).toHaveAttribute('aria-checked', 'true'));
  await user.click(screen.getByRole('switch', { name: 'revisor' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'revisor' })).not.toBeChecked());
  await user.click(screen.getByRole('combobox', { name: 'agente' }));
  await user.click(await screen.findByRole('option', { name: /^codex/ }));
  await waitFor(() => expect(bodies).toHaveLength(3));
  expect(bodies).toEqual([
    { prefix: 'HIVE', reviewer: { ...SAVED, when: 'save' } },
    { prefix: 'HIVE', reviewer: { ...SAVED, when: 'save', on: false } },
    { prefix: 'HIVE', reviewer: { ...SAVED, when: 'save', on: false, agent: 'codex', model: null } },
  ]);
  isRefused = true;
  await user.click(screen.getByRole('radio', { name: 'ao escrever' }));
  expect(await within(menu()).findByRole('alert')).toHaveTextContent('configuração do revisor não salva');
  expect(screen.getByRole('radio', { name: 'ao salvar' })).toHaveAttribute('aria-checked', 'true');
});

test("an agent annotation's card carries the agent mark, its title and body, and dismiss only; the variables pane never shows it on a row (#329)", async () => {
  const user = userEvent.setup();
  const server = serverOf({ review: () => json({ annotations: [ON_DEPTH] }) });
  stubItems(server);
  render(<PluginsWindow server={server} />);
  await open();
  await openMenu(user);
  await user.click(screen.getByRole('button', { name: 'revisar agora' }));
  await waitFor(() => expect(counter('revisor · 2 anotações')).toBeInTheDocument());
  await user.keyboard('{Escape}');
  fireEvent.click(counter('revisor · 2 anotações')); // the lint's, first
  fireEvent.click(counter('revisor · 2 anotações')); // then the agent's
  const card = within(margin()).getByRole('article', { name: ON_DEPTH.title });
  expect(card).toHaveTextContent('agente');
  expect(card).toHaveTextContent(ON_DEPTH.body);
  expect(within(card).getByRole('button', { name: 'dispensar' })).toBeEnabled();
  expect(within(card).queryByRole('button', { name: 'aplicar correção' })).not.toBeInTheDocument();
  const depth = within(screen.getByRole('list', { name: 'variáveis' })).getByRole('listitem', { name: 'reviewDepth' });
  expect(depth).toHaveTextContent('definida e nunca usada');
  expect(depth).not.toHaveTextContent(ON_DEPTH.title);
});

test('without a scope (a non-markdown file) review now is disabled (#329)', async () => {
  const user = userEvent.setup();
  const review = { config: SAVED, running: false, canReview: false, now: vi.fn(), set: vi.fn() };
  const annotations = { list: [], review, canDismiss: true, openAt: vi.fn(), next: vi.fn(), close: vi.fn(), dismiss: vi.fn(), apply: vi.fn() } satisfies Annotations;
  render(<ReviewerMenu annotations={annotations} workspaces={[]} />);
  await user.click(chevron2());
  expect(await screen.findByRole('button', { name: 'revisar agora' })).toBeDisabled();
});
const chevron2 = (): HTMLElement => screen.getByRole('button', { name: 'menu do revisor' });
