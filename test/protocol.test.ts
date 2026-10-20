import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, PROTOCOL_BLOCKS, renderProtocol, SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';
import type { RenderedPassage } from '../src/protocol-inserts.js';

const FROM_THE_HIVE = 'This text comes from the Hive, the app that runs this session.';
// #367 / #417: a plain question with background work in flight keeps the task green until that work ends
const ASK_WHILE_RUNNING = 'also while a subagent, a background shell or a scheduled job (cron) is still running';
const NEVER_CHAT_ALONE = 'never ask in chat alone';

const missing = (text: string, phrases: string[]): string[] => phrases.filter((phrase) => !text.includes(phrase));

test('STAGE_PROTOCOL tells a stage run to call hive_done only once everything is finished, with its result, to ask through hive_ask even while background work runs, and hive_stop\'s rules (#167)', () => {
  assert.ok(STAGE_PROTOCOL.startsWith(FROM_THE_HIVE), STAGE_PROTOCOL);
  assert.deepEqual(missing(STAGE_PROTOCOL, [
    'no subagent or background task still running',
    'call the `hive_done` tool and end your turn. Never call it earlier.',
    'as `result`, e.g. `{ "spec": "docs/hive/specs/x-design.md" }`',
    'Every question for the user goes through `hive_ask`',
    'end your turn without `hive_done`.',
    ASK_WHILE_RUNNING,
    NEVER_CHAT_ALONE,
    'call `hive_stop` instead of `hive_done`',
    '"wontDo"', '"duplicate"', '`duplicateOf`',
    'Never close the issue yourself.',
    'you learn a fact about this repository that a later task would need, call `hive_remember` with it.',
  ]), []);
  assert.equal(STAGE_PROTOCOL.includes('curl'), false, 'the tools are MCP tools: no route, no worker id');
});

test('SESSION_PROTOCOL leaves hive_done and hive_stop to the user and carries the same hive_ask rule (#167)', () => {
  assert.ok(SESSION_PROTOCOL.startsWith(FROM_THE_HIVE), SESSION_PROTOCOL);
  assert.deepEqual(missing(SESSION_PROTOCOL, [
    'The user drives this session.',
    'say so in chat and suggest moving the task to its next stage',
    'Call `hive_done` only when the user confirms or asks for it',
    'as `result`',
    'Every question for the user goes through `hive_ask`',
    ASK_WHILE_RUNNING,
    NEVER_CHAT_ALONE,
    'Call `hive_stop` only when the user asks for it',
    'you learn a fact about this repository that a later task would need, call `hive_remember` with it.',
  ]), []);
  assert.equal(SESSION_PROTOCOL.includes('Never call it earlier'), false, 'a free session never ends the stage on its own (#283)');
  // a word, not a substring: "discard" (#803) is fine
  assert.equal(/\bcard\b/.test(SESSION_PROTOCOL), false, 'the glossary name is task');
});

test('both protocols tell the worker how to find why code is the way it is and to keep a risky attempt undoable, right after the memory line (#803)', () => {
  const why = 'To learn why code is the way it is, follow it back: `git blame` or `git log` on the lines, the PR the commit names (`gh pr view`), the issue it closes and the spec or plan it links.';
  const undo = 'Before a large or risky change, commit the work that passes, so the attempt can be thrown away with git; try an experiment you may discard in a separate worktree.';
  for (const protocol of [STAGE_PROTOCOL, SESSION_PROTOCOL]) {
    const lines = protocol.split('\n');
    const remember = lines.findIndex((line) => line.includes('`hive_remember`'));
    assert.ok(remember > 0, protocol);
    assert.deepEqual(lines.slice(remember + 1, remember + 3), [why, undo]);
  }
});

test('both protocols tell the worker to stop with block when another issue must be done first (#294)', () => {
  for (const protocol of [STAGE_PROTOCOL, SESSION_PROTOCOL]) {
    assert.deepEqual(missing(protocol, ['call `hive_stop` with `block` (that issue\'s number)', 'starts the task again once it closes']), []);
  }
});

// Today's texts, byte for byte (#336): the blocks give them ids and change none of their words
const INTRO = 'This text comes from the Hive, the app that runs this session. Its tools `hive_done`, `hive_ask` and `hive_stop` report to it.';
const RESULT = 'If the work produced something later stages need (a spec path, a plan path…), pass it to `hive_done` as `result`, e.g. `{ "spec": "docs/hive/specs/x-design.md" }`.';
const ASK_LAST = 'Do this also while a subagent, a background shell or a scheduled job (cron) is still running: never ask in chat alone, or the Hive keeps showing this session as working until that work ends.';
const STOP = 'with `reason` "wontDo" (or "duplicate", plus `duplicateOf`: the original issue number) the Hive closes the issue; without `reason` the task only stops. Never close the issue yourself. When the task cannot go on until another issue is done, call `hive_stop` with `block` (that issue\'s number) instead: the Hive records the blocker and starts the task again once it closes.';
const REMEMBER = 'When the user corrects you, or you learn a fact about this repository that a later task would need, call `hive_remember` with it.';
const WHY = 'To learn why code is the way it is, follow it back: `git blame` or `git log` on the lines, the PR the commit names (`gh pr view`), the issue it closes and the spec or plan it links.';
const UNDO = 'Before a large or risky change, commit the work that passes, so the attempt can be thrown away with git; try an experiment you may discard in a separate worktree.';
const TODAY_STAGE = [
  INTRO, '',
  'When this command is completely finished (nothing left to do, no subagent or background task still running, no answer pending from the user), call the `hive_done` tool and end your turn. Never call it earlier.',
  RESULT,
  'Every question for the user goes through `hive_ask`: call it with the question, ask it in chat and end your turn without `hive_done`.', ASK_LAST,
  `If the task will not be done, call \`hive_stop\` instead of \`hive_done\`: ${STOP}`,
  REMEMBER, WHY, UNDO, '',
].join('\n');
const TODAY_SESSION = [
  INTRO, '',
  "The user drives this session. When you believe the task's work is finished, say so in chat and suggest moving the task to its next stage.",
  'Call `hive_done` only when the user confirms or asks for it: it moves the task to its next stage at once.',
  RESULT,
  'Every question for the user goes through `hive_ask`: call it with the question, ask it in chat and end your turn.', ASK_LAST,
  `Call \`hive_stop\` only when the user asks for it: ${STOP}`,
  REMEMBER, WHY, UNDO, '',
].join('\n');

test('the constants are today\'s texts, byte for byte (#336)', () => {
  assert.deepEqual([STAGE_PROTOCOL, SESSION_PROTOCOL], [TODAY_STAGE, TODAY_SESSION]);
});

const KINDS = ['stage', 'session'] as const;
const passage = (id: string, after: string, text?: string): RenderedPassage =>
  ({ id, after, orphan: !(PROTOCOL_BLOCKS as readonly string[]).includes(after), ...(text === undefined ? {} : { text }), errors: [] });

test('renderProtocol with no passage and nothing off is today\'s text for both kinds; remember is the one block a tool drops (#336)', () => {
  assert.equal(renderProtocol('stage', [], []), TODAY_STAGE);
  assert.equal(renderProtocol('session', [], []), TODAY_SESSION);
  assert.deepEqual(BLOCKS.map((b) => b.id), [...PROTOCOL_BLOCKS]);
  assert.deepEqual(BLOCKS.filter((b) => b.tool !== undefined).map((b) => [b.id, b.tool]), [['remember', 'hive_remember']]);
});

test('hive_remember off drops the remember block from both kinds; hive_applied and hive_create_task have no block (#336)', () => {
  for (const kind of KINDS) {
    const all = renderProtocol(kind, [], []);
    assert.equal(renderProtocol(kind, ['hive_remember'], []), all.replace(`${REMEMBER}\n`, ''));
    assert.equal(renderProtocol(kind, ['hive_applied', 'hive_create_task'], []), all);
  }
});

test('a passage lands right after its anchor in both kinds, several on one anchor in the order given, an orphan after the last block, an empty or failed render adds nothing, and one on a block turned off keeps its place (#336)', () => {
  const passages = [
    passage('p1', 'ask', 'first\nsecond line'), passage('p2', 'ask', 'third'), passage('p3', 'intro', 'under intro'),
    passage('p4', 'gone', 'orphan'), passage('p5', 'done', ''), passage('p6', 'done'),
  ];
  for (const kind of KINDS) {
    const text = renderProtocol(kind, [], passages);
    const lines = text.split('\n');
    const ask = lines.indexOf(ASK_LAST);
    assert.deepEqual(lines.slice(ask + 1, ask + 4), ['first', 'second line', 'third'], kind);
    assert.deepEqual(lines.slice(0, 3), [INTRO, 'under intro', ''], 'the blank line closes the intro and what follows it');
    assert.deepEqual(lines.slice(-3), [UNDO, 'orphan', '']);
    assert.equal(text, renderProtocol(kind, [], passages.slice(0, 4)), 'p5 rendered empty and p6 failed: nothing, not even a blank line');
  }
  const lines = renderProtocol('stage', ['hive_remember'], [passage('p1', 'remember', 'mine')]).split('\n');
  assert.equal(lines[lines.indexOf('mine') + 1], WHY, 'the block goes, the user\'s passage stays where it was');
});
