import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';

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
