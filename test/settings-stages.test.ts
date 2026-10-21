import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import {
  actionLabel, addableActions, badEvaluation, canContinueSession, deletionMoves, emptyRow, emptyStage, entryKey, entryKeys, entryLabel, fromKeys, stageDraft, stageFrom, stageMeta, stageRenamesFrom, withAction, withEntry, withoutAction,
} from '../src/ui/lib/settings-stages.js';
import { draftVerdicts } from '../src/ui/lib/settings-transitions.js';
import type { SourceAction, Stage, Task } from '../src/types.js';

const move = (column: string): SourceAction => ({ type: 'move', column });
const CLOSE: SourceAction = { type: 'close' };
const ARCHIVE: SourceAction = { type: 'archive' };
const ROWS = [{ id: 'r1', name: 'work' }, { id: 'r2', name: 'notes' }];
const COLUMNS = ['Ready', 'Done'];
const types = (list: SourceAction[]): string[] => list.map((a) => (a.type === 'move' ? `move:${a.column}` : a.type));

test('the draft keeps the action lists by row and stageFrom sends them by name; empty lists are left out (#515)', () => {
  const stage: Stage = { name: 'dev', from: { work: ['Ready'] }, onStart: { work: [move('In progress'), CLOSE] }, prompt: 'x' };
  const draft = stageDraft(stage, ROWS);
  assert.deepEqual(draft.onStart, { r1: [move('In progress'), CLOSE] });
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  const emptied = stageFrom({ ...draft, onStart: { r1: [] } }, ROWS);
  assert.equal('onStart' in emptied, false, 'no list, no key');
  assert.deepEqual(stageFrom(draft, [{ id: 'r1', name: ' job ' }]).onStart, { job: [move('In progress'), CLOSE] }, 'a renamed row sends under its new name (#278)');
});

test('a commands stage keeps its names, its switch and onMissing through the draft; a new draft starts the switch on and onMissing on fail; another action sends none of them (#755)', () => {
  const stage: Stage = { name: 'checks', from: { work: ['Checks'] }, action: 'commands', commands: ['build', 'lint'], stopOnFailure: false, onMissing: 'skip' };
  const draft = stageDraft(stage, ROWS);
  assert.deepEqual([draft.action, draft.commands, draft.stopOnFailure, draft.onMissing], ['commands', ['build', 'lint'], false, 'skip']);
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  assert.deepEqual([emptyStage().commands, emptyStage().stopOnFailure, emptyStage().onMissing], [[], true, 'fail']);
  const turned = stageDraft({ name: 'dev', from: {}, prompt: 'x' }, ROWS);
  assert.deepEqual([turned.stopOnFailure, turned.onMissing], [true, 'fail'], 'a stage turned into commands in the form starts with the switch on and onMissing on fail');
  const prompt = stageFrom({ ...draft, action: '', prompt: '/x' }, ROWS);
  assert.equal('commands' in prompt || 'stopOnFailure' in prompt || 'onMissing' in prompt, false);
  const removal = stageFrom({ ...draft, action: 'deleteActivity' }, ROWS);
  assert.deepEqual([removal.action, 'commands' in removal, 'stopOnFailure' in removal, 'onMissing' in removal], ['deleteActivity', false, false, false]);
});

test('addableActions offers only what keeps the list valid, per source type and moment (#515)', () => {
  assert.deepEqual(types(addableActions([], 'github', COLUMNS, false)), ['move:Ready', 'move:Done', 'archive', 'remove', 'close', 'delete']);
  assert.deepEqual(types(addableActions([move('Done')], 'github', COLUMNS, false)), ['archive', 'remove', 'close', 'delete'], 'one move per list');
  assert.deepEqual(types(addableActions([ARCHIVE], 'github', COLUMNS, false)), ['move:Ready', 'move:Done', 'close'], 'one leaving action per list');
  assert.deepEqual(types(addableActions([CLOSE], 'github', COLUMNS, false)), ['move:Ready', 'move:Done', 'archive', 'remove', 'delete']);
  assert.deepEqual(types(addableActions([], 'github', COLUMNS, true)), ['move:Ready', 'move:Done', 'close'], 'nothing that leaves on start');
});

test('withAction keeps a leaving action last; withoutAction returns a new list (#515)', () => {
  assert.deepEqual(withAction([ARCHIVE], CLOSE), [CLOSE, ARCHIVE]);
  assert.deepEqual(withAction([move('A')], ARCHIVE), [move('A'), ARCHIVE]);
  assert.deepEqual(withAction([], CLOSE), [CLOSE]);
  const list = [CLOSE, ARCHIVE];
  assert.deepEqual(withoutAction(list, 1), [CLOSE]);
  assert.deepEqual(list, [CLOSE, ARCHIVE], 'the input is not mutated');
  const map: Record<string, SourceAction[]> = { a: [CLOSE] };
  assert.deepEqual([withEntry(map, 'a', undefined), withEntry(map, 'b', [ARCHIVE])], [{}, { a: [CLOSE], b: [ARCHIVE] }]);
  assert.deepEqual(map, { a: [CLOSE] });
});

test('stageMeta reads what a stage does in one line (#515)', () => {
  setLanguage('pt');
  const stage = { ...emptyStage(), name: 'dev' };
  assert.equal(stageMeta({ ...stage, action: 'deleteActivity' }, 'claude'), t('settings.stages.meta.deleteActivity'));
  assert.equal(stageMeta({ ...stage, approval: true }, 'claude'), t('settings.stages.meta.gate'));
  assert.equal(stageMeta({ ...stage, prompt: '  ' }, 'claude'), t('settings.stages.meta.show'));
  assert.equal(stageMeta({ ...stage, prompt: '/hive-spec {url}' }, 'claude'), 'claude · hive-spec');
  assert.equal(stageMeta({ ...stage, prompt: '/hive-spec {url}', agent: 'claude' }, 'claude'), 'claude · hive-spec', 'a pinned agent (#516)');
  assert.equal(stageMeta({ ...stage, prompt: `  ${'x'.repeat(30)} more` }, 'claude'), `claude · ${'x'.repeat(24)}`);
});

test("a stage's agent round-trips: '' is no key, a pin is kept, a cleanup sends none (#516)", () => {
  assert.equal(emptyStage().agent, '');
  const base: Stage = { name: 'dev', from: { work: ['Ready'] }, prompt: 'x' };
  assert.equal(stageDraft(base, ROWS).agent, '', 'absent = the default');
  assert.equal('agent' in stageFrom(stageDraft(base, ROWS), ROWS), false);
  const pinned: Stage = { ...base, agent: 'claude' };
  assert.equal(stageDraft(pinned, ROWS).agent, 'claude');
  assert.deepEqual(stageFrom(stageDraft(pinned, ROWS), ROWS), pinned, 'kept even when it equals the default');
  const cleanup = stageFrom({ ...stageDraft(pinned, ROWS), prompt: '', action: 'deleteActivity' }, ROWS);
  assert.equal('agent' in cleanup, false, 'the parser refuses an agent next to an action');
});

test('entry keys join a row id and a column, split on the first colon, and read as "source · column" (#515)', () => {
  assert.deepEqual(entryKeys({ r1: ['Ready', 'Doing'], r2: ['todo'] }, ROWS), ['r1:Ready', 'r1:Doing', 'r2:todo']);
  assert.deepEqual(entryKeys({ r1: ['Ready'], gone: ['todo'] }, ROWS), ['r1:Ready'], 'a removed source\'s entry is not shown');
  assert.equal(entryKey('r1', 'a:b'), 'r1:a:b');
  assert.deepEqual(fromKeys(['r1:Ready', 'r2:todo', 'r1:a:b']), { r1: ['Ready', 'a:b'], r2: ['todo'] });
  assert.deepEqual(fromKeys([]), {});
  assert.equal(entryLabel('r2:Ready', ROWS), 'notes · Ready');
  assert.equal(entryLabel('r2:Ready', [ROWS[0], { id: 'r2', name: ' ' }]), '#2 · Ready', 'an unnamed row reads as its place');
});

test('actionLabel names each action in the user\'s language (#515)', () => {
  setLanguage('pt');
  assert.deepEqual([move('Done'), { type: 'remove' }, CLOSE, { type: 'delete' }, ARCHIVE].map((a) => actionLabel(a as SourceAction)), ['mover para Done', 'remover da source', 'concluir', 'apagar', 'arquivar']);
});

test('stageFrom sends handoff only on a prompt stage that starts a new session; stageDraft reads it back (#692)', () => {
  const stage: Stage = { name: 'plan', from: {}, prompt: '/hive:new-plan {url}', handoff: true };
  const draft = stageDraft(stage, ROWS);
  assert.equal(draft.handoff, true);
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  assert.equal('handoff' in stageFrom({ ...draft, session: 'continue' }, ROWS), false, 'the parser refuses it next to continue');
  assert.equal('handoff' in stageFrom({ ...draft, action: 'deleteActivity' }, ROWS), false, 'nor next to an action');
  assert.equal('handoff' in stageFrom({ ...draft, prompt: '  ' }, ROWS), false, 'nor on a stage without a prompt: a gate never spawns');
  assert.equal(emptyStage().handoff, false);
});

test('a commands stage\'s meta lists its names, or the action with none (#755)', () => {
  setLanguage('pt');
  assert.equal(stageMeta({ ...emptyStage(), action: 'commands', commands: ['build', 'lint'] }, 'claude'), 'build, lint');
  assert.equal(stageMeta({ ...emptyStage(), action: 'commands' }, 'claude'), 'executar comandos');
});

test('a wait-for-CI stage keeps its checks, its switch and its wait through the draft; a new draft starts on required, 60m and the switch off; checks go only with list and an empty wait sends no key (#834)', () => {
  const stage: Stage = { name: 'ci', from: { work: ['CI'] }, action: 'waitForCi', ciChecks: 'list', checks: ['build', 'e2e-*'], rerunOnce: true, timeout: '30m' };
  const draft = stageDraft(stage, ROWS);
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  const fresh = emptyStage();
  assert.deepEqual([fresh.ciChecks, fresh.checks, fresh.rerunOnce, fresh.timeout], ['required', [], false, '60m']);
  assert.deepEqual(stageFrom({ ...draft, ciChecks: 'required', timeout: ' ' }, ROWS), { name: 'ci', from: { work: ['CI'] }, action: 'waitForCi', ciChecks: 'required', rerunOnce: true });
  assert.equal(stageDraft({ ...stage, timeout: undefined }, ROWS).timeout, '', 'a saved wait with no limit stays without one');
  const prompt = stageFrom({ ...draft, action: '', prompt: '/x' }, ROWS);
  assert.equal(['ciChecks', 'checks', 'rerunOnce', 'timeout'].some((key) => key in prompt), false);
});

test('a gate draft sends approval alone; a prompt stage sends its verdicts when it has some (#134)', () => {
  assert.deepEqual(stageFrom({ ...emptyStage(), name: 'PR', gate: true, approval: true, prompt: 'left over', model: 'opus' }, ROWS), { name: 'PR', from: {}, approval: true });
  assert.deepEqual(stageFrom({ ...emptyStage(), name: 'Rev', prompt: '/r', verdicts: ['ok', 'redo'] }, ROWS).verdicts, ['ok', 'redo']);
  assert.equal('verdicts' in stageFrom({ ...emptyStage(), name: 'Rev', prompt: '/r' }, ROWS), false);
  assert.deepEqual([stageDraft({ name: 'PR', from: {}, approval: true }, ROWS).gate, stageDraft({ name: 'B', from: {}, prompt: '/b', verdicts: ['ok'] }, ROWS).verdicts], [true, ['ok']]);
});

test('stageRenamesFrom sends each saved stage whose trimmed name changed; a new stage renames nothing (#861)', () => {
  const spec = stageDraft({ name: 'spec', from: {} }, ROWS);
  assert.equal(spec.savedName, 'spec');
  assert.equal('savedName' in emptyStage(), false);
  assert.deepEqual(stageRenamesFrom([{ ...spec, name: ' Spec ' }, { ...emptyStage(), name: 'new' }, stageDraft({ name: 'dev', from: {} }, ROWS)]), { spec: 'Spec' });
});

test('deletionMoves counts the tasks of the deleted stages by destination, under the new names; adjacent deletions meet on one survivor (#861)', () => {
  const saved: Stage[] = [{ name: 'spec', from: { work: ['Backlog'] } }, { name: 'dev', from: { work: ['Ready'] } }, { name: 'qa', from: { work: ['QA'] } }, { name: 'done', from: { work: ['Done'] } }];
  const drafts = [{ ...stageDraft(saved[0], ROWS), name: 'Spec' }, stageDraft(saved[3], ROWS)]; // spec renamed, dev and qa deleted
  const next = drafts.map((d) => stageFrom(d, ROWS));
  const at = (n: number, stage: string, column: string): Task => ({ item: { itemId: `work:${n}`, id: String(n), title: '', body: '', url: '', source: 'work' }, stage, boardColumn: column, auto: true });
  assert.deepEqual(deletionMoves(drafts, saved, next, [at(1, 'dev', 'Ready'), at(2, 'qa', 'QA'), at(3, 'done', 'Done'), at(4, 'qa', 'Done')]), [{ stage: 'Spec', n: 2 }, { stage: 'done', n: 1 }]);
  assert.deepEqual(deletionMoves(drafts, saved, next, [at(3, 'done', 'Done')]), [], 'no deleted stage holds a task');
});

test('a skill stage keeps its skill, its specialized agent and every prompt key through the draft, and sends no prompt (#710)', () => {
  const stage: Stage = { name: 'plan', from: { work: ['Plan'] }, action: 'skill', skill: 'new-plan', agent: 'codex', model: 'gpt-5.6-terra', specializedAgent: 'hive:planner', session: 'continue', approval: true, verdicts: ['redo'], maxWorkers: 2 };
  const draft = stageDraft(stage, ROWS);
  assert.deepEqual([draft.action, draft.skill, draft.specializedAgent, draftVerdicts(draft)], ['skill', 'new-plan', 'hive:planner', ['redo']]);
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  assert.equal('prompt' in stageFrom({ ...draft, prompt: 'left over' }, ROWS), false);
  assert.deepEqual([emptyStage().skill, emptyStage().specializedAgent], ['', '']);
});

test('a prompt stage sends its specialized agent only with a prompt to run, a Hive action sends neither key, and a skill stage\'s chip names its skill (#710)', () => {
  setLanguage('pt');
  const draft = { ...emptyStage(), name: 'dev', specializedAgent: 'hive:designer' };
  assert.equal(stageFrom({ ...draft, prompt: '/x' }, ROWS).specializedAgent, 'hive:designer');
  assert.equal('specializedAgent' in stageFrom(draft, ROWS), false, 'a blank prompt runs nothing: the parser refuses it there');
  const commands = stageFrom({ ...draft, prompt: '/x', skill: 'new-plan', action: 'commands', commands: ['lint'] }, ROWS);
  assert.equal('specializedAgent' in commands || 'skill' in commands, false);
  assert.equal(stageMeta({ ...draft, action: 'skill', skill: 'new-plan' }, 'claude'), 'claude · new-plan');
  assert.equal(stageMeta({ ...draft, action: 'skill', agent: 'codex' }, 'claude'), 'codex · hive skill');
});

test('a stage may continue the previous session only when an earlier stage runs the same agent: never the first, never the first with its agent (#710)', () => {
  const run = (extra: Partial<ReturnType<typeof emptyStage>>) => ({ ...emptyStage(), name: 'x', prompt: '/x', ...extra });
  const stages = [run({}), { ...emptyStage(), name: 'gate', gate: true, approval: true }, run({ agent: 'codex' }), run({}), run({ agent: 'codex' }), run({ action: 'skill', skill: 'new-plan' })];
  assert.deepEqual(stages.map((_, i) => canContinueSession(stages, i, 'claude')), [false, false, false, true, true, true]);
  assert.equal(canContinueSession(stages, 2, 'codex'), true, "the default agent is codex: the first stage's agent");
  assert.equal(canContinueSession([{ ...emptyStage(), name: 'c', action: 'commands' }, run({})], 1, 'claude'), false, 'a commands stage opens no session');
});

test('an evaluate stage keeps its reviewers, judge, threshold and rubric through the draft, its cap too; a new draft has no reviewer, the judge on the default agent and 7; an empty pick sends no key (#877)', () => {
  setLanguage('pt');
  const stage: Stage = {
    name: 'eval', from: { work: ['Eval'] }, action: 'evaluate', maxWorkers: 1,
    reviewers: [{ agent: 'claude', specializedAgent: 'hive:security-reviewer', focus: 'security' }, { agent: 'codex', model: 'gpt-5.6-terra', focus: 'the spec' }],
    judge: { agent: 'claude', model: 'opus' }, threshold: 8, rubric: 'a\nb',
  };
  const draft = stageDraft(stage, ROWS);
  assert.deepEqual(stageFrom(draft, ROWS), stage);
  assert.deepEqual(draft.reviewers.map((r) => [r.agent, r.model, r.specializedAgent, r.focus]), [['claude', '', 'hive:security-reviewer', 'security'], ['codex', 'gpt-5.6-terra', '', 'the spec']]);
  const fresh = emptyStage('codex');
  assert.deepEqual([fresh.reviewers, fresh.judge.agent, fresh.judge.model, fresh.threshold, fresh.rubric], [[], 'codex', '', '7', '']);
  assert.equal(stageDraft({ name: 'p', from: {}, prompt: '/x' }, ROWS, 'codex').judge.agent, 'codex', 'a stage turned into one starts its judge on the default');
  const prompt = stageFrom({ ...draft, action: '', prompt: '/x' }, ROWS);
  assert.equal(['reviewers', 'judge', 'threshold', 'rubric'].some((key) => key in prompt), false);
  assert.equal(stageMeta(draft, 'claude'), '2 revisores e um juiz');
});

test('badEvaluation: a blank focus, a threshold off 0..10 or not whole, a rubric with no line (#877)', () => {
  const ok = { ...emptyStage(), action: 'evaluate' as const, reviewers: [{ ...emptyRow('claude'), focus: 'x' }], rubric: 'a' };
  assert.equal(badEvaluation(ok), false);
  for (const bad of [{ reviewers: [{ ...emptyRow('claude'), focus: ' ' }] }, { threshold: '11' }, { threshold: '6.5' }, { threshold: '' }, { rubric: ' \n ' }]) assert.equal(badEvaluation({ ...ok, ...bad }), true, JSON.stringify(bad));
  assert.equal(badEvaluation({ ...ok, action: 'commands' as const, rubric: '' }), false, 'only an evaluate stage');
});
