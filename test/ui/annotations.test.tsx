import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { removeVariable } from '../../src/template-edit';
import { setLanguage } from '@/i18n';
import { FAKE_LINE_HEIGHT, FakeEditor, resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, json, readOf, type SaveBody, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// VARS_TEXT with e2eCommand valued in every workspace: the one annotation left is reviewDepth's, unused, on header line 6. Visual mode hides
// the header (1–9) and the chain's markers (12, 14), so it sits at line 10; the chain's chip sits at line 12
const ONE_VARS = VARS_TEXT.replace('{ hive-site: pnpm e2e,', '{ agent-hive: pnpm e2e, hive-site: pnpm e2e,');
const HEADLINE = 'variável não usada reviewDepth';
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
afterEach(() => vi.unstubAllGlobals());

test('an annotation underlines its line; on a header line in visual mode it sits at the first visible line, a note where a card would cover a chip; the note opens the card and Esc closes it (#327)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open();
  await waitFor(() => expect(view().decorations.filter((d) => d.options.inlineClassName === 'template-annotation-yellow').map((d) => [d.range.startLineNumber, d.range.startColumn])).toEqual([[6, 3]]));
  const note = await within(margin()).findByRole('button', { name: HEADLINE });
  await waitFor(() => expect(note).toHaveStyle({ top: `${9 * FAKE_LINE_HEIGHT}px` }));
  fireEvent.click(note);
  expect(within(margin()).getByRole('article', { name: HEADLINE })).toHaveAttribute('data-open', 'true');
  expect(view().position).toEqual({ lineNumber: 10, column: 1 });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(within(margin()).queryByRole('article')).not.toBeInTheDocument();
  expect(within(margin()).getByRole('button', { name: HEADLINE })).toBeInTheDocument();
});

test('in text mode the annotation stays on its own line, with room for a card; "apply fix" removes the declaration and the annotation goes (#327)', async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ save: (id, body) => { saves.push(body); return echo(id, body); } }));
  render(<PluginsWindow />);
  await open();
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  const card = await within(margin()).findByRole('article', { name: HEADLINE });
  await waitFor(() => expect(card).toHaveStyle({ top: `${5 * FAKE_LINE_HEIGHT}px` }));
  fireEvent.click(within(card).getByRole('button', { name: 'aplicar correção' }));
  const removed = removeVariable(ONE_VARS, 'reviewDepth');
  if (!removed.ok) throw new Error(removed.error.message);
  await waitFor(() => expect(view().model.getValue()).toBe(removed.text));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(screen.queryByRole('group', { name: 'anotações' })).not.toBeInTheDocument();
});
