import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { applyProposal, type AssistAnswer, proposalHunk } from '../../src/assist';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { type AssistBody, BUILD_TEXT, CATALOGUE, type ItemsServer, json, readOf, type SaveBody, SPEC_TEXT, stubItems, VARS_ORIGINAL, VARS_TEXT } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const BUILD = readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT, 'scripts/slice.py': 'print(1)\n' });
const SPEC = readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT });
const PROPOSAL = { from: 9, to: 9, text: 'Intro.\nThen /hive:new-pr.' };
const ANSWER: AssistAnswer = { proposal: PROPOSAL, hunk: proposalHunk(BUILD_TEXT, PROPOSAL), text: applyProposal(BUILD_TEXT, PROPOSAL), changed: true };
// the look: line 9 kept above its two new lines
const LOOK_TEXT = BUILD_TEXT.replace('Intro, then /hive:new-pr.\n', 'Intro, then /hive:new-pr.\nIntro.\nThen /hive:new-pr.\n');
const PLACEHOLDER = 'pedir ao agente… selecione um trecho para mudar só ele';
const RUNNING = 'o agente está trabalhando…';
const NEVER = (): Promise<Response> => new Promise<Response>(() => undefined);
const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': BUILD, 'hive:new-spec@': SPEC }, ...extra });
const echo = (_id: string, body: SaveBody): Response => json(readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': body.text, 'scripts/slice.py': 'print(1)\n' }));
const view = (): FakeEditor => FakeEditor.all.at(-1)!;
const field = (): HTMLInputElement => screen.getByPlaceholderText(PLACEHOLDER);
const fileTab = (name: string): HTMLElement => screen.getByRole('tab', { name });
const sidebarItem = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: new RegExp(`^${name}`) });
async function open(name: string): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}
function ask(request: string): void {
  fireEvent.change(field(), { target: { value: request } });
  fireEvent.keyDown(field(), { key: 'Enter' });
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('⌘I with the focus in the text focuses the field: the capture-phase key never reaches Monaco (#331)', async () => {
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  const monacoKey = vi.fn();
  view().host.addEventListener('keydown', monacoKey);
  fireEvent.keyDown(view().host, { key: 'i', code: 'KeyI', ctrlKey: true });
  expect(field()).toHaveFocus();
  expect(monacoKey).not.toHaveBeenCalled();
});

test('a request over selected lines posts them; the proposal marks old and new lines in a read-only text; accept writes and saves it, the tab clean (#331)', async () => {
  const bodies: AssistBody[] = [];
  const saves: SaveBody[] = [];
  stubItems(serverOf({ assist: (_id, body) => { bodies.push(body); return json(ANSWER); }, save: (id, body) => { saves.push(body); return echo(id, body); } }));
  render(<PluginsWindow />);
  await open('new-build');
  act(() => view().select({ startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 26 }));
  ask('two sentences');
  await waitFor(() => expect(view().model.getValue()).toBe(LOOK_TEXT));
  expect(bodies).toEqual([{ version: 'mine', path: 'SKILL.md.liquid', text: BUILD_TEXT, request: 'two sentences', selection: { startLine: 9, endLine: 9 }, agent: 'claude' }]);
  const marks = view().decorations.filter((d) => d.options.isWholeLine && d.options.className?.startsWith('template-proposal'));
  expect(marks.map((d) => [d.range.startLineNumber, d.options.className])).toEqual([[9, 'template-proposal-old'], [10, 'template-proposal-new'], [11, 'template-proposal-new']]);
  expect(within(screen.getByRole('group', { name: 'condições' })).getByRole('button', { name: 'proposta do agente' })).toBeInTheDocument();
  expect([view().readOnly, field().disabled]).toEqual([true, true]);
  expect(screen.getByText('mudança marcada no texto (linhas 9–11)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'aceitar' }));
  await waitFor(() => expect(saves.map((s) => s.text)).toEqual([ANSWER.text]));
  await waitFor(() => expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'false'));
  expect([view().model.getValue(), view().readOnly, screen.queryByText('❯ two sentences')]).toEqual([ANSWER.text, false, null]);
});

test("discard puts the file's text back and writes nothing; both swaps set the value, so ⌘Z cannot bring the proposal back (#331)", async () => {
  const saves: SaveBody[] = [];
  stubItems(serverOf({ assist: () => json(ANSWER), save: (id, body) => { saves.push(body); return echo(id, body); } }));
  render(<PluginsWindow />);
  await open('new-build');
  const setValue = vi.spyOn(view().model, 'setValue');
  ask('two sentences');
  await waitFor(() => expect(view().model.getValue()).toBe(LOOK_TEXT));
  fireEvent.click(screen.getByRole('button', { name: 'descartar' }));
  await waitFor(() => expect(view().model.getValue()).toBe(BUILD_TEXT));
  expect([setValue.mock.calls.map(([text]) => text), saves, fileTab('SKILL.md.liquid').getAttribute('data-dirty'), view().readOnly]).toEqual([[LOOK_TEXT, BUILD_TEXT], [], 'false', false]);
});

test('switching file while the agent works cancels the request; the other file proposes nothing (#331)', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  stubItems(serverOf({ assist: (_id, _body, signal) => { signals.push(signal); return NEVER(); } }));
  render(<PluginsWindow />);
  await open('new-build');
  ask('two sentences');
  expect(await screen.findByText(RUNNING)).toBeInTheDocument();
  fireEvent.click(fileTab('scripts/slice.py'));
  await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  await waitFor(() => expect(field()).toBeEnabled());
  expect([screen.queryByText(RUNNING), screen.queryByRole('button', { name: 'aceitar' }), view().model.getValue()]).toEqual([null, null, 'print(1)\n']);
});

test("the chip's pick holds for the next item, and its request runs that agent (#331)", async () => {
  const bodies: AssistBody[] = [];
  stubItems(serverOf({ assist: (_id, body) => { bodies.push(body); return json({ ...ANSWER, text: body.text, changed: false }); } }));
  render(<PluginsWindow />);
  await open('new-build');
  fireEvent.click(screen.getByRole('button', { name: 'agente e modelo' }));
  fireEvent.click(within(await screen.findByRole('group', { name: 'agente' })).getByRole('button', { name: /codex/ }));
  fireEvent.click(sidebarItem('new-spec'));
  await waitFor(() => expect(view().model.getValue()).toBe(SPEC_TEXT));
  expect(screen.getByRole('button', { name: 'agente e modelo' })).toHaveTextContent('codex');
  ask('shorter');
  expect(await screen.findByText('o agente não propôs mudança')).toBeInTheDocument();
  expect(bodies.map((b) => [b.path, b.agent])).toEqual([['SKILL.md', 'codex']]);
});

test('while the agent works the annotation card offers no fix (#331)', async () => {
  // VARS_TEXT with e2eCommand valued everywhere: one annotation left, reviewDepth unused, whose card has a fix
  const oneVars = VARS_TEXT.replace('{ hive-site: pnpm e2e,', '{ agent-hive: pnpm e2e, hive-site: pnpm e2e,');
  const reads = { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': oneVars }), 'hive:new-build@': readOf('hive:new-build', null, { 'SKILL.md': VARS_ORIGINAL }) };
  stubItems(serverOf({ reads, assist: NEVER }));
  render(<PluginsWindow />);
  await open('new-build');
  fireEvent.click(within(screen.getByRole('group', { name: 'modo' })).getByRole('button', { name: 'texto' }));
  const margin = (): HTMLElement => screen.getByRole('group', { name: 'anotações' });
  expect(await within(margin()).findByRole('button', { name: 'aplicar correção' })).toBeInTheDocument();
  ask('drop reviewDepth');
  await screen.findByText(RUNNING);
  expect(within(margin()).queryByRole('button', { name: 'aplicar correção' })).toBeNull();
});
