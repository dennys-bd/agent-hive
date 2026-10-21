import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oldSetupPath } from '../src/ui/lib/settings-nested.js';

// The old setup line (#653): a RUN line that still adds a nested repo's worktree, which the Hive now adds before the setup.
const OLD = 'RUN main="$(git rev-parse --path-format=absolute --git-common-dir)/.." && git -C "$main/docs" worktree add "$PWD/docs" "$(git branch --show-current)"';

test('oldSetupPath flags a setup RUN line that adds a worktree on a nested path, matched as a whole path segment (#653)', () => {
  assert.equal(oldSetupPath(`${OLD}\nRUN pnpm install`, ['ee', 'docs']), 'docs');
  assert.equal(oldSetupPath('RUN git -C ee/core worktree add x', ['ee/core']), 'ee/core', 'a nested path with a slash');
  assert.equal(oldSetupPath('RUN pnpm install', ['docs']), undefined, 'no worktree add');
  assert.equal(oldSetupPath('RUN git -C "$main/docsite" worktree add "$PWD/docsite" x', ['docs']), undefined, 'a segment, never a prefix');
  assert.equal(oldSetupPath('COPY docs worktree add', ['docs']), undefined, 'RUN lines only');
  assert.equal(oldSetupPath(OLD, []), undefined, 'no nested repo');
});
