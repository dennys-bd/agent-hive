import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { docsClone } from '../../scripts/experiment/docs-git.js';
import { tempDir } from '../temp-dir.js';
import { fakeRun } from './fixtures.js';

test('docsClone runs git in docs/ and returns its paths; a missing clone, or one whose origin is not local, is refused (#79)', async (t) => {
  const root = await tempDir(t, 'lab-');
  const answer = (origin: string) => fakeRun((call) => (call.args[0] === 'remote' ? `${origin}\n` : `${join(root, 'docs', '.git')}\n`));
  await assert.rejects(docsClone(answer('/lab/hive-docs.git').run, root), /no docs clone/);
  await mkdir(join(root, 'docs', '.git'), { recursive: true });
  const local = answer('/lab/hive-docs.git');
  const { docs, paths } = await docsClone(local.run, root);
  assert.deepEqual(paths, { gitDir: join(root, 'docs', '.git'), origin: '/lab/hive-docs.git' });
  await docs('git', ['status']);
  assert.ok(local.calls.every((c) => c.cwd === join(root, 'docs')), 'every call runs in the docs clone');
  await assert.rejects(docsClone(answer('git@github.com:someone/docs.git').run, root), /must be a local repository/);
});
