import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { applyProposal, type AssistAnswer, proposalHunk } from '../../src/assist';
import { AssistFooter } from '@/components/plugins/AssistFooter';
import { AgentsContext } from '@/components/NewRunButton';
import type { Assist, AssistPick } from '@/hooks/use-assist';
import { setLanguage } from '@/i18n';
import { BUILD_TEXT, stubFetch } from './plugins-fixtures';

const PLACEHOLDER = 'pedir ao agente… selecione um trecho para mudar só ele';
const PROPOSAL = { from: 9, to: 9, text: 'Intro.\nThen /hive:new-pr.' };
const ANSWER: AssistAnswer = { proposal: PROPOSAL, hunk: proposalHunk(BUILD_TEXT, PROPOSAL), text: applyProposal(BUILD_TEXT, PROPOSAL), changed: true };
const CLAUDE: AssistPick = { agent: 'claude', model: '' };
const assistOf = (extra: Partial<Assist> = {}): Assist => ({ status: 'idle', ask: vi.fn(), accept: vi.fn(), discard: vi.fn(), ...extra });
const field = (): HTMLInputElement => screen.getByPlaceholderText(PLACEHOLDER);
const chip = (): HTMLButtonElement => screen.getByRole('button', { name: 'agente e modelo' });
interface Extra { pick?: AssistPick; isDisabled?: boolean; onAsk?(request: string): void; onPick?(pick: AssistPick): void }
const footer = (assist: Assist, extra: Extra = {}) => (
  <AssistFooter assist={assist} pick={extra.pick ?? CLAUDE} onPick={extra.onPick ?? vi.fn()} workspace="agent-hive" isDisabled={extra.isDisabled ?? false} onAsk={extra.onAsk ?? vi.fn()} />
);

beforeEach(() => {
  setLanguage('pt');
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

test('⌘I focuses the field; Enter sends the trimmed request and empties the field; an empty one sends nothing (#331)', () => {
  const onAsk = vi.fn();
  render(footer(assistOf(), { onAsk }));
  fireEvent.keyDown(document.body, { key: 'i', code: 'KeyI', ctrlKey: true });
  expect(field()).toHaveFocus();
  fireEvent.keyDown(field(), { key: 'Enter' });
  fireEvent.change(field(), { target: { value: '  two sentences  ' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect([onAsk.mock.calls, field().value]).toEqual([[['two sentences']], '']);
});

test('while the agent works the field is disabled, under the request line and "the agent is working…" (#331)', () => {
  render(footer(assistOf({ status: 'running', request: 'two sentences' })));
  expect(field()).toBeDisabled();
  expect(screen.getByText('❯ two sentences')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('o agente está trabalhando…');
});

test('a proposal names its marked lines and offers accept and discard with the reviewer note; the field stays disabled (#331)', () => {
  const assist = assistOf({ status: 'proposed', request: 'two sentences', answer: ANSWER });
  render(footer(assist));
  expect(screen.getByRole('status')).toHaveTextContent('mudança marcada no texto (linhas 9–11)');
  expect(screen.getByText('o revisor executa de novo depois')).toBeInTheDocument();
  expect(field()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'aceitar' }));
  fireEvent.click(screen.getByRole('button', { name: 'descartar' }));
  expect([vi.mocked(assist.accept).mock.calls.length, vi.mocked(assist.discard).mock.calls.length]).toEqual([1, 1]);
});

test('an idle footer keeps the answer line it was left with; a read-only text disables the field and the chip (#331)', () => {
  const { rerender } = render(footer(assistOf({ request: 'two sentences', line: 'plugins.assist.busy' })));
  expect(screen.getByRole('status')).toHaveTextContent('o agente já está trabalhando neste item');
  rerender(footer(assistOf(), { isDisabled: true }));
  expect([field().disabled, chip().disabled, screen.queryByRole('status')]).toEqual([true, true, null]);
});

test('the chip names the pick; its list holds only the available agents, and another agent goes back to its default model (#331)', async () => {
  const onPick = vi.fn();
  const { unmount } = render(footer(assistOf(), { pick: { agent: 'claude', model: 'opus' }, onPick }));
  expect(chip()).toHaveTextContent('claude');
  expect(chip()).toHaveTextContent('opus');
  fireEvent.click(chip());
  fireEvent.click(within(await screen.findByRole('group', { name: 'agente' })).getByRole('button', { name: /codex/ }));
  expect(onPick).toHaveBeenCalledWith({ agent: 'codex', model: '' });
  unmount();
  render(<AgentsContext.Provider value={[{ agent: 'claude', available: true }, { agent: 'codex', available: false }]}>{footer(assistOf())}</AgentsContext.Provider>);
  fireEvent.click(chip());
  const agents = within(await screen.findByRole('group', { name: 'agente' })).getAllByRole('button');
  expect(agents.map((button) => button.textContent)).toEqual(['claude']);
});
