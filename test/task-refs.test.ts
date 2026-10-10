import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRepository, resolveRef } from '../src/task-refs.js';
import type { Task } from '../src/types.js';

// A source task of `repository`'s issue n (#588); `id` is what its source shows: the number, or PREFIX-n with qualifyId
const issue = (itemId: string, repository: string, n: number, id = String(n)): Task => ({
  item: { itemId, id, title: `Issue ${n}`, body: '', url: `https://github.com/${repository}/issues/${n}`, source: 'gh', facets: { assignees: [], labels: [], repository, fields: {} } },
  stage: 'dev', boardColumn: 'Ready', auto: true,
});
const local: Task = { item: { itemId: 'local:11', id: 'HIVE-11', title: 'Local', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
const state = (...tasks: Task[]): { tasks: Task[] } => ({ tasks });

test('resolveRef #N: a task of the terminal\'s repository wins over the same number elsewhere; else the only one in the Hive, from any terminal (#588)', () => {
  const own = issue('app:5', 'acme/app', 5);
  const other = issue('lib:5', 'acme/lib', 5);
  assert.deepEqual(resolveRef(state(other, own), '#5', 'acme/app'), { taskId: 'app:5' });
  assert.deepEqual(resolveRef(state(other), '#5', 'acme/app'), { taskId: 'lib:5' }, 'unique across the Hive');
  assert.deepEqual(resolveRef(state(other), '#5'), { taskId: 'lib:5' }, 'a terminal with no repository still gets a unique one');
});

test('resolveRef #N with no single match: the issue in the terminal\'s repository on GitHub, or nothing without a repository (#588)', () => {
  const twice = state(issue('lib:5', 'acme/lib', 5), issue('web:5', 'acme/web', 5));
  assert.deepEqual(resolveRef(twice, '#5', 'acme/app'), { url: 'https://github.com/acme/app/issues/5' }, 'two elsewhere: no picker');
  assert.equal(resolveRef(twice, '#5'), undefined);
  assert.deepEqual(resolveRef(state(), '#42', 'acme/app'), { url: 'https://github.com/acme/app/issues/42' });
  assert.equal(resolveRef(state(), '#42'), undefined);
  assert.equal(resolveRef(state(), '#42', 'evil/x?y'), undefined, 'a repository not shaped owner/name builds no URL');
});

test('resolveRef #N reads the issue number from item.url, never item.id: a qualified id still resolves, and HIVE-11 is no #11 (#588)', () => {
  const qualified = issue('gh:9', 'acme/app', 9, 'GH-9');
  assert.deepEqual(resolveRef(state(qualified, local), '#9', 'acme/app'), { taskId: 'gh:9' });
  assert.deepEqual(resolveRef(state(qualified, local), '#11', 'acme/app'), { url: 'https://github.com/acme/app/issues/11' });
});

test('resolveRef PREFIX-N matches item.id exactly, case included, with no GitHub fallback (#588)', () => {
  const qualified = issue('gh:9', 'acme/app', 9, 'GH-9');
  assert.deepEqual(resolveRef(state(qualified, local), 'HIVE-11', 'acme/app'), { taskId: 'local:11' });
  assert.deepEqual(resolveRef(state(qualified, local), 'GH-9', 'acme/app'), { taskId: 'gh:9' });
  assert.equal(resolveRef(state(qualified, local), 'HIVE-12', 'acme/app'), undefined);
  assert.equal(resolveRef(state(qualified, local), 'gh-9', 'acme/app'), undefined);
});

test('githubRepository reads owner/name from a GitHub origin, https or ssh, with or without .git; any other remote gives none (#588)', () => {
  for (const remote of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'https://token@github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app/']) {
    assert.equal(githubRepository(remote), 'acme/app', remote);
  }
  for (const remote of ['', 'https://gitlab.com/acme/app.git', 'git@gitlab.com:acme/app.git', 'https://github.com/acme', 'https://github.com/acme/app/tree/x', '/srv/git/app.git', 'https://github.com/./app.git', 'https://github.com/acme/..', 'git@github.com:../app.git']) {
    assert.equal(githubRepository(remote), undefined, remote);
  }
});
