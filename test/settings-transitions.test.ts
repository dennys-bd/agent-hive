import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import { emptyStage, type StageDraft } from '../src/ui/lib/settings-stages.js';
import { draftLabel, draftVerdicts, emptyTransition, transitionDraft, transitionFrom, transitionsProblem, triggersOf, withApproval, withoutStage, type TransitionDraft } from '../src/ui/lib/settings-transitions.js';
import type { Transition, Trigger } from '../src/types.js';

// Settings › fluxo's transitions (#134): keyed by the stage drafts' ids, round-tripped to the config.
const ROWS = [{ id: 'r1', name: 'board' }];
const stage = (name: string, extra: Partial<StageDraft> = {}): StageDraft => ({ ...emptyStage(), name, ...extra });
const STAGES = [stage('Build', { prompt: '/b' }), stage('Checks', { action: 'commands', commands: ['lint'] }), stage('PR', { gate: true, approval: true })];
const back: Transition = {
  from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 3, prompt: 'Fix:\n\n{verdict}', session: { continueOf: 'Build' }, label: 'falhou', sources: { board: [{ type: 'move', column: 'In progress' }] },
};

test('a transition round-trips through its draft, keyed by stage ids, so a stage renamed while edited keeps its arrows (#134)', () => {
  const draft = transitionDraft(back, STAGES, ROWS);
  assert.deepEqual([draft.from, draft.to, draft.session, draft.maxTries, draft.sources], [STAGES[1].id, STAGES[0].id, { continueOf: STAGES[0].id }, '3', { r1: back.sources?.board }]);
  assert.deepEqual(transitionFrom(draft, STAGES, ROWS), back);
  const renamed = STAGES.map((s) => (s.name === 'Build' ? { ...s, name: 'Code' } : s));
  assert.deepEqual([transitionFrom(draft, renamed, ROWS).to, transitionFrom(draft, renamed, ROWS).session], ['Code', { continueOf: 'Code' }]);
  const plain = transitionDraft({ from: 'PR', to: 'end', when: 'approved' }, STAGES, ROWS);
  assert.deepEqual(transitionFrom({ ...plain, maxTries: '2', verdict: 'x', label: ' ' }, STAGES, ROWS), { from: 'PR', to: 'end', when: 'approved' }, 'tries and a verdict go only where they belong; a blank label is no key');
});

test('a new transition leaves its stage for the next one, or end after the last: approved after approval, passed after commands, done otherwise; a removed stage takes its arrows along (#134)', () => {
  assert.deepEqual([emptyTransition(STAGES[0], STAGES).to, emptyTransition(STAGES[0], STAGES).when], [STAGES[1].id, 'done']);
  assert.deepEqual([emptyTransition(STAGES[1], STAGES).when, emptyTransition(STAGES[1], STAGES).verdict], ['verdict', 'passed']);
  assert.deepEqual([emptyTransition(STAGES[2], STAGES).to, emptyTransition(STAGES[2], STAGES).when], ['end', 'approved']);
  const drafts = [transitionDraft(back, STAGES, ROWS), transitionDraft({ from: 'PR', to: 'end', when: 'approved' }, STAGES, ROWS)];
  assert.deepEqual(withoutStage(drafts, STAGES[0].id).map((d) => d.from), [STAGES[2].id]);
});

test('the verdicts and triggers a stage offers, a pill\'s words, and the form\'s own refusal (#134)', () => {
  setLanguage('pt');
  assert.deepEqual([[...draftVerdicts(stage('a', { prompt: '/x', verdicts: ['ok'] }))], [...draftVerdicts(STAGES[1])], [...draftVerdicts(STAGES[2])]], [['ok'], ['passed', 'failed'], []]);
  assert.deepEqual([triggersOf(stage('a', { prompt: '/x', verdicts: ['ok'] })), triggersOf(STAGES[1]), triggersOf(STAGES[2])], [['done', 'verdict'], ['verdict'], ['approved', 'feedback']]);
  const draft = transitionDraft(back, STAGES, ROWS);
  assert.equal(draftLabel({ ...draft, label: '' }), 'falhou · 3x');
  assert.equal(transitionsProblem([draft], STAGES), undefined);
  assert.equal(transitionsProblem([draft, { ...draft, id: 'twin' }], STAGES), 1, 'the same (from, when, verdict)');
  assert.equal(transitionsProblem([{ ...draft, verdict: '' }], STAGES), 0);
  assert.equal(transitionsProblem([{ ...draft, maxTries: '0' }], STAGES), 0);
  assert.equal(transitionsProblem([{ ...draft, to: 'gone' }], STAGES), 0);
});

test('withApproval swaps a stage\'s done exits to approved and back, keeps its verdict and feedback exits and every other stage\'s, and returns a new list (#918)', () => {
  const plan = stage('Plan', { prompt: '/p', verdicts: ['redo'] });
  const stages = [plan, ...STAGES];
  const exit = (from: StageDraft, when: Trigger, extra: Partial<TransitionDraft> = {}): TransitionDraft => ({ ...emptyTransition(from, stages), when, ...extra });
  const list = [exit(plan, 'done', { maxTries: '2' }), exit(plan, 'verdict', { verdict: 'redo', to: plan.id }), exit(STAGES[0], 'done')];
  const on = withApproval(list, plan.id, true);
  assert.deepEqual(on.map((d) => d.when), ['approved', 'verdict', 'done']);
  assert.equal(on[0].maxTries, '2', 'kept in the draft; transitionFrom drops it on a non-automatic trigger');
  assert.notEqual(on, list);
  assert.equal(on[1], list[1], 'an exit it does not swap is the same object');
  assert.deepEqual(list.map((d) => d.when), ['done', 'verdict', 'done'], 'the input is not mutated');
  const off = withApproval([...on, exit(plan, 'feedback', { to: plan.id })], plan.id, false);
  assert.deepEqual(off.map((d) => d.when), ['done', 'verdict', 'done', 'feedback'], 'feedback stays for the save check to point at');
});
