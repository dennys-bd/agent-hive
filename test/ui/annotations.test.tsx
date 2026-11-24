import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { removeVariable } from '../../src/template-edit';
import { CARD_HEIGHT } from '@/lib/annotation-layout';
import { setLanguage } from '@/i18n';
import { AnnotationMargin } from '@/components/plugins/Annotations';
import type { Annotations } from '@/hooks/use-annotations';
import type { AgentAnnotation } from '../../src/reviewer';
import type { LintAnnotation } from '../../src/template-lint';
import { REVIEWER_DEFAULTS } from '../../src/types';
import { FAKE_LINE_HEIGHT, FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// VARS_TEXT with e2eCommand valued in every workspace: the one annotation left is reviewDepth's, unused, on header line 6. Visual mode hides
// the header (1–9) and the chain's markers (12, 14), so it sits at line 10; the chain's chip sits at line 12
const ONE_VARS = VARS_TEXT.replace('{ hive-site: pnpm e2e,', '{ agent-hive: pnpm e2e, hive-site: pnpm e2e,');
const HEADLINE = 'variável não usada reviewDepth';
const BODY = 'reviewDepth está declarada mas o corpo nunca a usa.';
const textMode = (): void => { fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' })); };
const echo = (_id: string, body: SaveBody): Response => json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text }));
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({
  catalogue: CATALOGUE,
  reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': ONE_VARS }), 'hive:new-build@': readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL }) },
  save: echo,
  ...extra,
});
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const margin = (): HTMLElement => screen.getByRole('group', { name: 'anotações' });
async function open(): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-build/ }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('an annotation underlines its line; on a header line in visual mode it sits at the first visible line, a note where a card would cover a chip; the note opens the card and Esc closes it (#327)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  await waitFor(() => expect(view().decorations.filter((d) => d.options.inlineClassName === 'template-annotation-yellow').map((d) => [d.range.startLineNumber, d.range.startColumn])).toEqual([[6, 3]]));
  const note = await within(margin()).findByRole('button', { name: HEADLINE });
  await waitFor(() => expect(note).toHaveStyle({ top: `${9 * FAKE_LINE_HEIGHT}px` }));
  expect([note.classList.contains('border'), note.classList.contains('text-waiting')]).toEqual([false, true]); // #492: plain text in its severity's colour
  fireEvent.click(note);
  expect(within(margin()).getByRole('article', { name: HEADLINE })).toHaveAttribute('data-open', 'true');
  expect(view().position).toEqual({ lineNumber: 10, column: 1 });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(within(margin()).queryByRole('article')).not.toBeInTheDocument();
  expect(within(margin()).getByRole('button', { name: HEADLINE })).toBeInTheDocument();
});

test('Esc already handled by something else (Monaco widget, dialog) does not close the card (#327)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  fireEvent.click(await within(margin()).findByRole('button', { name: HEADLINE }));
  const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  handled.preventDefault();
  act(() => { window.dispatchEvent(handled); });
  expect(within(margin()).getByRole('article', { name: HEADLINE })).toBeInTheDocument();
});

test('in text mode the annotation stays on its own line, with room for a card; "apply fix" removes the declaration and the annotation goes (#327)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (id, body) => { saves.push(body); return echo(id, body); } }));
  render(<PluginsWindow />);
  await open();
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  const card = await within(margin()).findByRole('article', { name: HEADLINE });
  await waitFor(() => expect(card).toHaveStyle({ top: `${5 * FAKE_LINE_HEIGHT}px` }));
  // #492: the card on card, its headline with no dot, apply primary and dismiss outlined
  expect([card.classList.contains('bg-card'), card.querySelector('.rounded-full')]).toEqual([true, null]);
  const [apply, dismiss] = [within(card).getByRole('button', { name: 'aplicar correção' }), within(card).getByRole('button', { name: 'dispensar' })];
  expect([apply.classList.contains('bg-background'), dismiss.classList.contains('bg-background')]).toEqual([false, true]);
  fireEvent.click(apply);
  const removed = removeVariable(ONE_VARS, 'reviewDepth');
  if (!removed.ok) throw new Error(removed.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(removed.text));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(screen.queryByRole('group', { name: 'anotações' })).not.toBeInTheDocument();
});

test('the text, the map and the variables pane show the same annotation, and all three lose it on dismiss (#327)', async () => {
  const server = serverOf();
  stubItems(server);
  render(<PluginsWindow />);
  await open();
  const nav = screen.getByRole('navigation', { name: 'mapa' });
  const pane = screen.getByRole('list', { name: 'variáveis' });
  const dot = within(nav).getByRole('button', { name: 'anotações neste bloco' }); // a header line's annotation: on the first block
  expect(dot).toHaveAttribute('data-severity', 'yellow');
  expect(within(within(pane).getByRole('listitem', { name: 'reviewDepth' })).getByText('definida e nunca usada')).toBeInTheDocument();
  fireEvent.click(dot);
  const card = within(margin()).getByRole('article', { name: HEADLINE });
  const dismiss = within(card).getByRole('button', { name: 'dispensar' });
  await waitFor(() => expect(dismiss).toBeEnabled());
  fireEvent.click(dismiss);
  expect(within(nav).queryByRole('button', { name: 'anotações neste bloco' })).not.toBeInTheDocument();
  expect(within(pane).queryByText('definida e nunca usada')).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'anotações' })).not.toBeInTheDocument();
  expect(view().decorations.some((d) => d.options.inlineClassName === 'template-annotation-yellow')).toBe(false);
  await waitFor(() => expect(server.dismissed).toEqual({ 'hive:new-build@mine': ['SKILL.md.liquid\0unused\0unused variable reviewDepth\0  reviewDepth: { default: full }'] }));
});

test('the head counts the annotations: "next annotation" in its menu moves the text to the next one and opens its card, Esc closes it; at zero it reads "no annotations" and the row is disabled (#327, #492)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  const head = screen.getByTestId('head');
  fireEvent.click(await within(head).findByRole('button', { name: 'revisor · 1 anotação' }));
  fireEvent.click(await screen.findByRole('button', { name: 'próxima anotação' }));
  expect(view().position).toEqual({ lineNumber: 10, column: 1 });
  expect(within(margin()).getByRole('article', { name: HEADLINE })).toHaveAttribute('data-open', 'true');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(within(margin()).queryByRole('article')).not.toBeInTheDocument();
  act(() => view().model.type(ONE_VARS.replace('  reviewDepth: { default: full }\n', '')));
  expect(within(head).getByRole('button', { name: 'revisor · nenhuma anotação' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'próxima anotação' })).toBeDisabled();
});

test("a closed card's text is a button that opens it whole, with its ×; × closes it, and Esc closes it again (#980)", async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  textMode(); // room for a card at the annotation's own line
  const card = await within(margin()).findByRole('article', { name: HEADLINE });
  const body = within(card).getByRole('button', { name: BODY });
  expect([body.classList.contains('line-clamp-2'), card.style.height]).toEqual([true, `${CARD_HEIGHT}px`]);
  expect(within(card).queryByRole('button', { name: 'fechar a anotação' })).not.toBeInTheDocument();
  fireEvent.click(body);
  expect(card).toHaveAttribute('data-open', 'true');
  expect(within(card).queryByRole('button', { name: BODY })).not.toBeInTheDocument(); // open, the body is text to select
  expect([within(card).getByText(BODY).classList.contains('line-clamp-2'), within(card).getByText(HEADLINE).classList.contains('truncate'), card.style.height]).toEqual([false, false, '']);
  const close = within(card).getByRole('button', { name: 'fechar a anotação' });
  expect(close).toHaveAttribute('title', 'fechar · Esc');
  fireEvent.click(close);
  expect(card).toHaveAttribute('data-open', 'false');
  fireEvent.click(within(card).getByRole('button', { name: BODY }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(card).toHaveAttribute('data-open', 'false');
});

test("an open card that would pass the margin column grows upward, its bottom on its line's bottom (#980)", async () => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200); // the margin column
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150); // the open card, measured
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  textMode();
  const card = await within(margin()).findByRole('article', { name: HEADLINE });
  await waitFor(() => expect(card).toHaveStyle({ top: `${5 * FAKE_LINE_HEIGHT}px` }));
  fireEvent.click(within(card).getByRole('button', { name: BODY }));
  await waitFor(() => expect(card.style.bottom).toBe(`${200 - (5 * FAKE_LINE_HEIGHT + FAKE_LINE_HEIGHT)}px`));
  expect(card.style.top).toBe('');
});

// The margin on its own (#981): a lint fix, a lint advice, an agent fix and an agent advice, 200px apart, so each is a card
const LINT_FIX: LintAnnotation = { line: 1, severity: 'yellow', check: 'unused', title: 'unused variable depth', body: 'b', variable: 'depth' };
const LINT_ADVICE: LintAnnotation = { line: 20, severity: 'red', check: 'reference', title: 'unknown /nowhere', body: 'b', ref: '/nowhere' };
const AGENT_FIX: AgentAnnotation = {
  line: 40, severity: 'yellow', title: 'Ambiguous step', body: 'fine is not a check.', source: 'agent', kind: 'fix',
  span: 'If it looks fine, continue to the PR.', replacement: 'If no finding is high or critical,\ncontinue to the PR.',
};
const AGENT_ADVICE: AgentAnnotation = { line: 60, severity: 'red', title: 'No tie-break', body: 'say whether the plan or the spec wins.', source: 'agent', kind: 'advice' };
const ACTIONS = ['aplicar correção', 'pedir ao agente', 'dispensar'];
type Stub = Annotations & { passage?(request: string, line: number): void };

function marginOf(extra: Partial<Stub> = {}, canFix = true): Stub {
  const annotations: Stub = {
    list: [LINT_FIX, LINT_ADVICE, AGENT_FIX, AGENT_ADVICE],
    values: { variables: {}, builtIns: {} },
    writeValue: vi.fn(),
    review: { config: { ...REVIEWER_DEFAULTS, when: 'demand' }, running: false, canReview: true, now: vi.fn(), set: vi.fn() },
    canDismiss: true, openAt: vi.fn(), next: vi.fn(), close: vi.fn(), dismiss: vi.fn(), apply: vi.fn(), passage: vi.fn(), ...extra,
  };
  render(<AnnotationMargin annotations={annotations} tops={[0, 200, 400, 600]} chipTops={[]} canFix={canFix} lineHeight={20} columnHeight={1000} />);
  return annotations;
}
const card = (name: string): HTMLElement => screen.getByRole('article', { name });
const actionsOf = (name: string): (string | null)[] =>
  within(card(name)).getAllByRole('button').map((button) => button.textContent).filter((text) => ACTIONS.includes(text ?? ''));

test.each([
  ['pt', ['variável não usada depthcorreção', '/nowhere desconhecidaconselho', 'Ambiguous stepagentecorreção', 'No tie-breakagenteconselho']],
  ['en', ['unused variable depthfix', 'unknown /nowhereadvice', 'Ambiguous stepagentfix', 'No tie-breakagentadvice']],
] as const)('in %s, each card names its kind after its title, after the agent tag on an agent finding (#981)', (language, heads) => {
  setLanguage(language);
  marginOf();
  expect(screen.getAllByRole('article').map((article) => article.firstElementChild?.textContent)).toEqual(heads);
});

test('an open agent fix shows its proposed fix, the span as − lines on diff-del and the replacement as + lines on diff-add, in foreground mono; closed, it does not (#981)', () => {
  marginOf({ open: AGENT_FIX });
  const group = within(card('Ambiguous step')).getByRole('group', { name: 'correção proposta' });
  expect(group).toHaveClass('font-mono', 'text-foreground');
  expect([...group.children].map((row) => [row.textContent, row.classList.contains('bg-diff-del') ? 'del' : 'add'])).toEqual([
    ['−If it looks fine, continue to the PR.', 'del'], ['+If no finding is high or critical,', 'add'], ['+continue to the PR.', 'add'],
  ]);
  cleanup();
  marginOf();
  expect(screen.queryByRole('group', { name: 'correção proposta' })).not.toBeInTheDocument();
});

test('only a fix offers apply; only an agent advice offers ask the agent, which hands the bar its title: body and its line; every card keeps dismiss (#981)', () => {
  const annotations = marginOf();
  expect(['variável não usada depth', '/nowhere desconhecida', 'Ambiguous step', 'No tie-break'].map(actionsOf)).toEqual([
    ['aplicar correção', 'dispensar'], ['dispensar'], ['aplicar correção', 'dispensar'], ['pedir ao agente', 'dispensar'],
  ]);
  fireEvent.click(within(card('No tie-break')).getByRole('button', { name: 'pedir ao agente' }));
  expect(annotations.passage).toHaveBeenCalledWith('No tie-break: say whether the plan or the spec wins.', 60);
  fireEvent.click(within(card('Ambiguous step')).getByRole('button', { name: 'aplicar correção' }));
  expect(annotations.apply).toHaveBeenCalledWith(AGENT_FIX);
});

test("while the text is read-only neither apply nor ask the agent shows, and without the bar's entry point ask the agent does not either; dismiss stays (#981)", () => {
  marginOf({}, false);
  expect(['variável não usada depth', '/nowhere desconhecida', 'Ambiguous step', 'No tie-break'].map(actionsOf)).toEqual([['dispensar'], ['dispensar'], ['dispensar'], ['dispensar']]);
  cleanup();
  marginOf({ passage: undefined });
  expect(actionsOf('No tie-break')).toEqual(['dispensar']);
});
