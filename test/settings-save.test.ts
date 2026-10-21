import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { movedStages, nestedRefusal, renamedRules, renamedSwitchAt, stageRenamesOf } from '../src/settings-save.js';
import type { SourceConfig, Stage } from '../src/types.js';
import { GITHUB_ENTRY, workspacesAt } from './fakes.js';
import { tempDir } from './temp-dir.js';

const SAVED: Stage[] = [{ name: 'spec', from: {} }, { name: 'dev', from: {} }, { name: 'qa', from: {} }];
const NEXT: Stage[] = [{ name: 'Spec', from: {} }, { name: 'build', from: {} }, { name: 'qa', from: {} }];

test('stageRenamesOf takes a map of saved stages onto sent ones, drops a stage renamed to itself, and refuses the rest with the reason (#861)', () => {
  assert.deepEqual(stageRenamesOf({ spec: 'Spec', dev: 'build', qa: 'qa' }, SAVED, NEXT), { spec: 'Spec', dev: 'build' });
  assert.deepEqual(stageRenamesOf(undefined, SAVED, NEXT), {}, 'an omitted map renames nothing');
  assert.throws(() => stageRenamesOf({ nope: 'Spec' }, SAVED, NEXT), { message: 'Unknown stage to rename: "nope"' });
  assert.throws(() => stageRenamesOf({ spec: 'gone' }, SAVED, NEXT), { message: 'Renamed stage "gone" is not in the new stages' });
  assert.throws(() => stageRenamesOf({ spec: 'Spec', dev: 'Spec' }, SAVED, NEXT), { message: 'Two stages renamed to "Spec"' });
  assert.throws(() => stageRenamesOf(['spec'], SAVED, NEXT), { message: 'stageRenames must map stage names to stage names' });
  assert.deepEqual(movedStages({ spec: 'Spec', qa: 'qa' }), { spec: 'Spec' });
});

test('what the saved file names by a stage follows a rename: each usage rule\'s stage and each source\'s switchAt, once per value (#861)', () => {
  assert.deepEqual(renamedRules([{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'dev' }, { source: 'day', percent: 90, signal: 'red' }], { dev: 'build' }),
    [{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'build' }, { source: 'day', percent: 90, signal: 'red' }]);
  const source: SourceConfig = { ...GITHUB_ENTRY, switchAt: 'spec' };
  assert.deepEqual(renamedSwitchAt([source], { spec: 'Spec', dev: 'spec' })?.map((s) => s.switchAt), ['Spec'], 'one pass: a chain never renames twice');
});

test('nestedRefusal names the workspace, the nested path and the cause with its fix; nested repos that pass refuse nothing (#653)', async (t) => {
  const run = promisify(execFile);
  const repo = await realpath(await tempDir(t, 'outer-'));
  await run('git', ['-C', repo, 'init', '--quiet']);
  await writeFile(join(repo, '.gitignore'), 'docs/\n');
  await run('git', ['-C', repo, 'init', '--quiet', 'docs']);
  await mkdir(join(repo, 'docs', 'agent'));
  const config = (nestedRepos: string[]) => ({ comb: { workspaces: [{ ...workspacesAt(repo)[0], nestedRepos }] } });
  assert.equal(await nestedRefusal(config(['docs'])), undefined);
  assert.deepEqual(await nestedRefusal(config(['docs', 'docs/agent'])), {
    status: 400, message: "hive: nested repo docs/agent: docs/agent is not a git repository's top level · the top level is docs · use docs",
  });
});
