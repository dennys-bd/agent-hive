import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prsOf } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { HookPayload, Item, State, Worker } from '../src/types.js';
import { chained, STAGES } from './fakes.js';

// #874: a PostToolUse after a permission prompt or an elicitation is the user's answer: the worker goes back to working, for every agent
const ID = 'board:item1';
const ITEM: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const PR = 'https://github.com/o/r/pull/9';
const BASH: HookPayload = { hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'echo hi > made.txt' }, tool_response: '' };

// Task 1 running fila (fakes' one stage) in the only worker, green
const running = (): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) }, { type: 'poll', source: 'board', items: [{ item: ITEM, column: 'Ready' }] }).state;
const ptyOf = (s: State): string => s.workers[0]?.runId ?? '';
const hook = (s: State, payload: HookPayload, gitlabHosts: readonly string[] = []): State => reduce(s, { type: 'hook', ptyId: ptyOf(s), payload, gitlabHosts }).state;
const notified = (s: State, kind: string, message: string): State => hook(s, { hook_event_name: 'Notification', notification_type: kind, message });
const seen = (s: State): [Worker['status'], Worker['question'], Worker['lastEvent']] => [s.workers[0]?.status, s.workers[0]?.question, s.workers[0]?.lastEvent];

test('a PostToolUse after a permission prompt puts the worker back to working with the tool, the question cleared (#874)', () => {
  const waiting = notified(running(), 'permission_prompt', 'Run command: echo hi > made.txt');
  assert.equal(seen(waiting)[0], 'waiting');
  const approved = hook(waiting, BASH);
  assert.deepEqual(seen(approved), ['working', undefined, { kind: 'tool', detail: 'bash: echo hi > made.txt' }]);
  assert.equal('waitingSince' in approved.workers[0]!, false, 'the wait is left (#233)');
});

test('a PostToolUse after an elicitation (Copilot\'s ask_user) puts the worker back to working (#874, spike §2)', () => {
  const waiting = notified(running(), 'elicitation_dialog', 'Pick your preferred color');
  const answered = hook(waiting, { hook_event_name: 'PostToolUse', tool_name: 'ask_user', tool_input: { message: 'Pick your preferred color' } });
  assert.deepEqual(seen(answered), ['working', undefined, { kind: 'tool', detail: 'ask_user' }]);
});

test('a PostToolUse leaves a worker waiting on its own question (ask) or after its turn ended (turn) as it was (#874)', () => {
  const start = running();
  const asked = reduce(start, { type: 'ask', ptyId: ptyOf(start), question: 'Which base?' }).state;
  assert.deepEqual(seen(hook(asked, BASH)), ['waiting', 'Which base?', { kind: 'ask' }]);
  const askedThenPrompted = notified(asked, 'permission_prompt', 'Run command: ls');
  assert.deepEqual(seen(hook(askedThenPrompted, BASH)), ['waiting', 'Which base?', { kind: 'ask' }], 'an approval does not answer hive_ask');
  const idle = hook(start, { hook_event_name: 'Stop' });
  assert.deepEqual(seen(hook(idle, BASH)), ['waiting', undefined, { kind: 'turn' }]);
});

test('a PostToolUse carrying a PR URL after a wait both moves the worker and marks the PR (#874, #663)', () => {
  const waiting = notified(running(), 'permission_prompt', 'Run command: gh pr create --fill');
  const opened = hook(waiting, { hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'gh pr create --fill' }, tool_response: `${PR}\n` });
  assert.deepEqual(seen(opened), ['working', undefined, { kind: 'pr' }]);
  assert.deepEqual(prsOf(opened, ID).map((pr) => pr.url), [PR]);
});

test('a PostToolUse leaves agent_needs_input open, and a subagent\'s PostToolUse never answers the worker\'s prompt (#874)', () => {
  const needs = notified(running(), 'agent_needs_input', 'Claude needs your input');
  assert.equal(seen(hook(needs, BASH))[0], 'waiting', 'no tool opened it, so no tool\'s end closes it');
  const waiting = hook(notified(running(), 'permission_prompt', 'Run command: ls'), { hook_event_name: 'SessionStart', session_id: 'a0a0a0a0-0000-4000-8000-000000000001' });
  const own = waiting.workers[0]?.sessionId;
  assert.ok(own !== undefined, 'the worker holds its session id');
  const child = hook(waiting, { ...BASH, session_id: 'b1b1b1b1-0000-4000-8000-000000000002' });
  assert.equal(seen(child)[0], 'waiting', 'a subagent\'s tool');
  assert.equal(seen(hook(waiting, { ...BASH, session_id: own }))[0], 'working', 'the worker\'s own tool');
});

const MR = 'https://git.example.com/acme/platform/app/-/merge_requests/3';
const LISTED = ['git.example.com'];
// glab mr create's output as Claude Code's Bash tool reports it: the branch line, the MR's title, then its link
const glab = (url: string, command = 'glab mr create --fill --yes'): HookPayload => ({
  hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command },
  tool_response: { stdout: `Creating merge request for feature into main in acme/platform/app\n\n!3 Add it (feature)\n ${url}\n`, stderr: '' },
});

test('a glab mr create on a listed GitLab host records its MR once, as gh pr create does; a second identical hook adds nothing; gitlab.com needs no list (#1052)', () => {
  const opened = hook(running(), glab(MR), LISTED);
  assert.deepEqual(prsOf(opened, ID).map((pr) => [pr.url, pr.state]), [[MR, 'open']]);
  assert.deepEqual(seen(opened)[2], { kind: 'pr' });
  assert.deepEqual(prsOf(hook(opened, glab(MR), LISTED), ID).map((pr) => pr.url), [MR], 'once');
  const onCom = 'https://gitlab.com/acme/app/-/merge_requests/12';
  assert.deepEqual(prsOf(hook(running(), glab(onCom)), ID).map((pr) => pr.url), [onCom]);
});

test('a glab mr create whose link is on a host that is not GitLab records nothing, nor does another glab command; gh pr create finds the GitHub link as before (#1052)', () => {
  assert.deepEqual(prsOf(hook(running(), glab(MR)), ID), [], 'git.example.com is not listed');
  assert.deepEqual(prsOf(hook(running(), glab('https://code.example.org/acme/app/-/merge_requests/3'), LISTED), ID), []);
  assert.deepEqual(prsOf(hook(running(), glab(MR, 'glab mr view 3'), LISTED), ID), [], 'only a create');
  const gh = hook(running(), { hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'gh pr create --fill' }, tool_response: `${PR}\n` }, LISTED);
  assert.deepEqual(prsOf(gh, ID).map((pr) => pr.url), [PR]);
});
