import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adoptTranscript, copyTranscript, dropCopiedTranscript, removeTranscripts } from '../src/transcript.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { tempDir } from './temp-dir.js';

test('removeTranscripts deletes each listed session\'s <id>.jsonl and <id>/ in the transcript dir of the worktree and nothing else there; a file already gone is a debug line; an id that is not a session id is skipped (#236)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const worktree = '/repo/.hive/worktrees/hive-1-t';
  const dir = transcriptDir(worktree, env);
  const [used, other, missing] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002', 'c1b2c3d4-0000-4000-8000-000000000003'];
  await mkdir(join(dir, used, 'subagents'), { recursive: true });
  await mkdir(join(dir, 'memory'));
  for (const file of [`${used}.jsonl`, join(used, 'subagents', 'agent-1.jsonl'), `${other}.jsonl`, join('memory', 'MEMORY.md'), 'bad id.jsonl']) {
    await writeFile(join(dir, file), '{}\n');
  }
  const lines: string[] = [];
  await removeTranscripts(worktree, '/repo', [used, missing, 'bad id'].map((id) => ({ id })), { debug: (line) => lines.push(line) }, env);
  assert.deepEqual((await readdir(dir)).sort(), [`${other}.jsonl`, 'bad id.jsonl', 'memory'].sort(), 'another session, a file no id named and memory/ stay');
  assert.deepEqual(lines, [`transcript ${missing}.jsonl: already gone`, `transcript ${missing}: already gone`]);
});

test('adoptTranscript moves a session\'s <id>.jsonl and <id>/ from the worktree\'s transcript dir to the main repo\'s, once; true when it is already there, false in neither or for an id that is not a session id (#208)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const [worktree, repo] = ['/repo/.hive/worktrees/hive-1-t', '/repo'];
  const [from, to] = [transcriptDir(worktree, env), transcriptDir(repo, env)];
  const [id, bare, lost] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002', 'c1b2c3d4-0000-4000-8000-000000000003'];
  await mkdir(join(from, id, 'subagents'), { recursive: true });
  for (const file of [`${id}.jsonl`, join(id, 'subagents', 'agent-1.jsonl'), `${bare}.jsonl`, 'bad id.jsonl']) await writeFile(join(from, file), '{}\n');
  assert.equal(await adoptTranscript(worktree, repo, id, 'claude', env), true);
  assert.deepEqual((await readdir(to)).sort(), [id, `${id}.jsonl`].sort());
  assert.deepEqual(await readdir(join(to, id, 'subagents')), ['agent-1.jsonl']);
  assert.deepEqual((await readdir(from)).sort(), [`${bare}.jsonl`, 'bad id.jsonl'].sort(), 'moved, never copied');
  assert.equal(await adoptTranscript(worktree, repo, id, 'claude', env), true, 'already in the main repo: opened before');
  assert.equal(await adoptTranscript(worktree, repo, bare, 'claude', env), true, 'a session with no subagents: only the file');
  assert.equal(await adoptTranscript(worktree, repo, lost, 'claude', env), false, 'in neither: nothing to resume');
  assert.equal(await adoptTranscript(worktree, repo, 'bad id', 'claude', env), false, 'not a session id: never a path');
  assert.deepEqual(await readdir(from), ['bad id.jsonl']);
});

test('removeTranscripts removes a repo session in both transcript dirs, the worktree\'s and the main repo\'s, and a worktree session only in the worktree\'s (#208)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const [worktree, repo] = ['/repo/.hive/worktrees/hive-1-t', '/repo'];
  const [from, to] = [transcriptDir(worktree, env), transcriptDir(repo, env)];
  const [moved, stayed] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  for (const dir of [from, to]) {
    await mkdir(dir, { recursive: true });
    for (const id of [moved, stayed]) await writeFile(join(dir, `${id}.jsonl`), '{}\n');
  }
  await removeTranscripts(worktree, repo, [{ id: moved, repo: true }, { id: stayed }], { debug: () => undefined }, env);
  assert.deepEqual(await readdir(from), []);
  assert.deepEqual(await readdir(to), [`${stayed}.jsonl`], 'a worktree session never ran in the main repo: that file is not the task\'s');
});

test('copyTranscript copies <id>.jsonl from the first cwd whose transcript dir has it into the destination\'s, never its <id>/ and never over a file already there; same for one dir; missing for an absent session or a non-uuid id (#587)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const [worktree, repo, other] = ['/repo/.hive/worktrees/hive-1-t', '/repo', '/repo/.hive/worktrees/hive-2-u'];
  const id = 'a1b2c3d4-0000-4000-8000-000000000001';
  const from = transcriptDir(worktree, env);
  await mkdir(join(from, id, 'subagents'), { recursive: true });
  await writeFile(join(from, `${id}.jsonl`), '{"a":1}\n');
  assert.equal(await copyTranscript([worktree, repo], other, id, 'claude', env), 'copied', 'a repo session looks in the worktree\'s dir first (A13)');
  const to = transcriptDir(other, env);
  assert.deepEqual(await readdir(to), [`${id}.jsonl`], 'the conversation only: subagents stay');
  assert.equal(await readFile(join(to, `${id}.jsonl`), 'utf8'), '{"a":1}\n');
  assert.deepEqual((await readdir(from)).sort(), [id, `${id}.jsonl`].sort(), 'copied, never moved');
  await writeFile(join(from, `${id}.jsonl`), '{"a":2}\n');
  assert.equal(await copyTranscript([worktree], other, id, 'claude', env), 'same', 'one is there already: never overwritten');
  assert.equal(await readFile(join(to, `${id}.jsonl`), 'utf8'), '{"a":1}\n');
  assert.equal(await copyTranscript([worktree], worktree, id, 'claude', env), 'same', 'one dir: nothing to copy');
  assert.equal(await copyTranscript([repo], other, 'b1b2c3d4-0000-4000-8000-000000000002', 'claude', env), 'missing');
  assert.equal(await copyTranscript([worktree], other, 'bad id', 'claude', env), 'missing');
});

test('copyTranscript that fails to read its source leaves a transcript already in the destination untouched, and no staged file (#587)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const [worktree, other] = ['/repo/.hive/worktrees/hive-1-t', '/repo/.hive/worktrees/hive-2-u'];
  const id = 'a1b2c3d4-0000-4000-8000-000000000001';
  const [from, to] = [transcriptDir(worktree, env), transcriptDir(other, env)];
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(join(from, `${id}.jsonl`), '{"a":2}\n');
  await writeFile(join(to, `${id}.jsonl`), '{"real":1}\n');
  await chmod(join(from, `${id}.jsonl`), 0o000);
  t.after(() => chmod(join(from, `${id}.jsonl`), 0o600));
  await assert.rejects(copyTranscript([worktree], other, id, 'claude', env));
  assert.equal(await readFile(join(to, `${id}.jsonl`), 'utf8'), '{"real":1}\n');
  assert.deepEqual(await readdir(to), [`${id}.jsonl`]);
});

test('dropCopiedTranscript removes only <id>.jsonl in the dir; a file already gone is a debug line; a non-uuid id touches nothing (#587)', async (t) => {
  const dir = await tempDir(t, 'transcripts-');
  const [id, other] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  await mkdir(join(dir, id));
  for (const name of [`${id}.jsonl`, `${other}.jsonl`, 'bad id.jsonl']) await writeFile(join(dir, name), '{}\n');
  const lines: string[] = [];
  const log = { debug: (line: string) => lines.push(line) };
  await dropCopiedTranscript(dir, id, log);
  await dropCopiedTranscript(dir, id, log);
  await dropCopiedTranscript(dir, 'bad id', log);
  assert.deepEqual((await readdir(dir)).sort(), [id, `${other}.jsonl`, 'bad id.jsonl'].sort());
  assert.deepEqual(lines, [`transcript ${id}.jsonl: already gone`]);
});
