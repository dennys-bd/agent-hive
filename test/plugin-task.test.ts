import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';

const PLUGIN = pluginSource();
const read = (...parts: string[]): Promise<string> => readFile(join(PLUGIN, ...parts), 'utf8');
const skill = (name: string): Promise<string> => read('skills', name, 'SKILL.md.liquid');
const NEW_SKILLS = ['new-build', 'new-plan', 'new-pr', 'new-spec'];

test('reference/conventions.md says once to read the task with hive_task, and when to fall back to the branch name and gh issue view (#7)', async () => {
  const text = await read('reference', 'conventions.md');
  assert.match(text, /^## The task$/m);
  for (const part of ['`hive_task`', '`task: null`', 'the branch name', 'gh issue view <n> --json number,title,body,url,comments', '`commentsError`', 'GitHub issue']) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /result` `hive_task` answers/, 'the previous stage\'s files are looked up in the task\'s result too');
});

test('every new-* skill reads the task through hive_task alone, whatever its source; decomposition calls hive_task itself and keeps gh issue view as its fallback (#7, #431, #432, #433, #434)', async () => {
  for (const name of NEW_SKILLS) {
    const text = await skill(name);
    assert.ok(text.includes('as `hive_task` answers it'), `${name} names the task tool itself`);
    assert.doesNotMatch(text, /gh issue|branch name|under "The task"/, `${name} has no source of its own to fall back on: outside the Hive it has only its argument`);
  }
  const decomposition = await skill('decomposition');
  for (const part of ['`hive_task`', '`task: null`', 'gh issue view', 'branch name']) assert.ok(decomposition.includes(part), part);
});
