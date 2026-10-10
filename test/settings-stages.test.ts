import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import {
  actionLabel, addableActions, emptyStage, entryKey, entryKeys, entryLabel, fromKeys, stageDraft, stageFrom, stageMeta, withAction, withEntry, withoutAction,
} from '../src/ui/lib/settings-stages.js';
import type { SourceAction, Stage } from '../src/types.js';

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
