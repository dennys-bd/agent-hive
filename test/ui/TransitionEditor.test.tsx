import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TransitionEditor } from '@/components/settings/TransitionEditor';
import type { StageSource } from '@/components/settings/StageEditor';
import { setLanguage } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-stages';
import { emptyTransition, type TransitionDraft } from '@/lib/settings-transitions';

// The transition editor (#134, 6b): de, para, quando, veredito, tries or the user's note, the prompt, the session and the sources.
const stage = (name: string, extra: Partial<StageDraft> = {}): StageDraft => ({ ...emptyStage(), name, ...extra });
const STAGES = [stage('Build', { prompt: '/b' }), stage('Checks', { action: 'commands', commands: ['lint'] }), stage('PR', { gate: true, approval: true })];
const SOURCES: StageSource[] = [{ id: 'r1', name: 'board', type: 'github', options: ['Ready', 'Done'] }];
function Harness({ initial, onChange, onRemove = () => {} }: { initial: TransitionDraft; onChange(d: TransitionDraft): void; onRemove?(): void }) {
  const [d, setD] = useState(initial);
  return <TransitionEditor transition={d} stages={STAGES} sources={SOURCES} onUpdate={(patch) => { const next = { ...d, ...patch }; onChange(next); setD(next); }} onRemove={onRemove} />;
}
const setup = (initial: TransitionDraft) => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const onRemove = vi.fn();
  render(<Harness initial={initial} onChange={onChange} onRemove={onRemove} />);
  return { user, onRemove, last: (): TransitionDraft => onChange.mock.lastCall?.[0] as TransitionDraft };
};
beforeEach(() => setLanguage('pt'));
// The keyboard opens a Radix select reliably in jsdom, as the neighbouring Settings tests do
const pick = async (user: ReturnType<typeof userEvent.setup>, select: string, option: string): Promise<void> => {
  screen.getByRole('combobox', { name: select }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: option }));
};

test('an automatic transition: the title, automática, de disabled, para with fim, quando and veredito, tentativas and the fixed ao esgotar (#134)', async () => {
  const { user, last } = setup(emptyTransition(STAGES[1], STAGES));
  expect(screen.getByText('Checks → PR · passou')).toBeInTheDocument();
  expect(screen.getByText('automática')).toBeInTheDocument();
  expect(screen.getByLabelText('de')).toBeDisabled();
  expect(screen.getByText('a tarefa espera você, com a evidência')).toBeInTheDocument();
  await pick(user, 'veredito', 'falhou');
  expect(last().verdict).toBe('failed');
  await pick(user, 'para', 'Build');
  expect(last().to).toBe(STAGES[0].id);
  await user.type(screen.getByLabelText('tentativas'), '3');
  expect(last().maxTries).toBe('3');
});

test('a user transition: sua, the note instead of tries, the feedback placeholder, the session offering each prompt stage, the sources and remover (#134)', async () => {
  const fb: TransitionDraft = { ...emptyTransition(STAGES[2], STAGES), when: 'feedback', to: STAGES[0].id };
  const { user, last, onRemove } = setup(fb);
  expect(screen.getByText('sua')).toBeInTheDocument();
  expect(screen.queryByLabelText('tentativas')).not.toBeInTheDocument();
  expect(screen.getByText('você já está vendo a tarefa: transições suas não têm limite de voltas')).toBeInTheDocument();
  expect(screen.getByLabelText('prompt da transição')).toHaveAttribute('placeholder', 'vazio = o seu feedback');
  await pick(user, 'sessão', 'continua a de Build');
  expect(last().session).toEqual({ continueOf: STAGES[0].id });
  const table = screen.getByRole('table', { name: 'nas sources' });
  expect(within(table).getByText('não mexe')).toBeInTheDocument();
  await user.click(within(table).getByRole('button', { name: 'adicionar ação: board, ao passar' }));
  await user.click(screen.getByRole('menuitem', { name: 'mover para Done' }));
  expect(last().sources).toEqual({ r1: [{ type: 'move', column: 'Done' }] });
  await user.click(screen.getByRole('button', { name: 'remover transição' }));
  expect(onRemove).toHaveBeenCalledOnce();
});

test('with a stage to go back to, a voltar para <stage> button leads the editor and calls onBack; without one there is none (#887)', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  const { unmount } = render(
    <TransitionEditor transition={emptyTransition(STAGES[1], STAGES)} stages={STAGES} sources={SOURCES} backTo="Checks" onBack={onBack} onUpdate={vi.fn()} onRemove={vi.fn()} />,
  );
  const back = screen.getByRole('button', { name: 'voltar para Checks' });
  expect(back.compareDocumentPosition(screen.getByRole('heading', { level: 3, name: 'Checks → PR · passou' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(back);
  expect(onBack).toHaveBeenCalledOnce();
  unmount();
  setup(emptyTransition(STAGES[1], STAGES));
  expect(screen.queryByRole('button', { name: /^voltar para/ })).not.toBeInTheDocument();
});

test('the prompt hint offers only what the trigger fills: {verdict} on a verdict, {feedback} on a feedback, the stage\'s placeholders on done and approved (#411)', () => {
  const hints: [TransitionDraft['when'], string][] = [
    ['verdict', 'use {verdict} (a evidência ou a saída do veredito) e as variáveis da etapa'],
    ['feedback', 'use {feedback} (o seu texto) e as variáveis da etapa'],
    ['done', 'use as variáveis da etapa'],
    ['approved', 'use as variáveis da etapa'],
  ];
  for (const [when, hint] of hints) {
    const { unmount } = render(<TransitionEditor transition={{ ...emptyTransition(STAGES[1], STAGES), when }} stages={STAGES} sources={[]} onUpdate={() => {}} onRemove={() => {}} />);
    expect(screen.getByText(hint)).toBeInTheDocument();
    if (when !== 'feedback') expect(screen.queryByText(/\{feedback\}/)).not.toBeInTheDocument();
    unmount();
  }
});
