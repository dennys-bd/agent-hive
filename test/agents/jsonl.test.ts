import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addTokens, eachLine, finiteTokens, firstLine, newTally, TRANSCRIPT_MAX_BYTES, tally, turnUsage, writtenSince } from '../../src/agents/jsonl.js';
import { ZERO_TOKENS } from '../../src/facts.js';
import { type Machine, MachineError } from '../../src/machine.js';
import { fakeMachine } from '../fake-machine.js';
import { tempDir } from '../temp-dir.js';

const LOCAL = fakeMachine({ env: {} });

test('firstLine reads a file\'s first line only, undefined for an empty file, and refuses what is not a regular file (#929)', async (t) => {
  const dir = await tempDir(t, 'jsonl-');
  const path = join(dir, 'a.jsonl');
  await writeFile(path, '{"type":"session_meta"}\n{"type":"turn_context"}\n');
  assert.equal(await firstLine(LOCAL, path), '{"type":"session_meta"}');
  await writeFile(join(dir, 'empty.jsonl'), '');
  assert.equal(await firstLine(LOCAL, join(dir, 'empty.jsonl')), undefined);
  await mkdir(join(dir, 'folder.jsonl'));
  await assert.rejects(firstLine(LOCAL, join(dir, 'folder.jsonl')), /not a regular file/);
});

test('tally counts each id once, only at or after since, a subagent\'s share apart; turnUsage lists the models in the order met (#742, #929)', () => {
  const t = newTally();
  const byType = { input: 1, output: 2, cache_write: 3, cache_read: 4 };
  tally(t, { id: 'a', byType, model: 'm1', at: 100 }, 50, false);
  tally(t, { id: 'a', byType, model: 'm1', at: 100 }, 50, false); // the same response again
  tally(t, { id: 'b', byType, at: 10 }, 50, false); // before the stage run
  tally(t, { id: 'c', byType, model: 'm3', at: Number.NaN }, 50, false); // no time: not the stage run's
  tally(t, { id: 'd', byType, model: 'm2', at: 60 }, 50, true);
  assert.deepEqual(turnUsage(t), { tokens: { input: 2, output: 4, cache_write: 6, cache_read: 8 }, models: ['m1', 'm2'], subagentTokens: byType, tokensByModel: { m1: byType, m2: byType } });
  assert.equal(finiteTokens(turnUsage(t).tokens), true);
  assert.equal(finiteTokens({ ...ZERO_TOKENS, output: Number.POSITIVE_INFINITY }), false);
});

test('tally splits the tokens by model, a response with none under unknown, a subagent\'s included, so the split sums to the tokens (#271)', () => {
  const t = newTally();
  const byType = { input: 1, output: 2, cache_write: 3, cache_read: 4 };
  tally(t, { id: 'a', byType, model: 'm1', at: 100 }, 50, false);
  tally(t, { id: 'b', byType, at: 100 }, 50, false); // no model
  tally(t, { id: 'c', byType, model: 'm1', at: 100 }, 50, true); // a subagent's, on the same model
  tally(t, { id: 'd', byType, model: 'm2', at: 10 }, 50, false); // before the stage run: in no model
  const usage = turnUsage(t);
  assert.deepEqual(usage.tokensByModel, { m1: { input: 2, output: 4, cache_write: 6, cache_read: 8 }, unknown: byType });
  assert.deepEqual(usage.models, ['m1'], 'models lists only the named ones');
  assert.deepEqual(Object.values(usage.tokensByModel).reduce(addTokens, ZERO_TOKENS), usage.tokens);
});

test('writtenSince compares the file\'s mtime; a missing file is never fresh (#929)', async (t) => {
  const path = join(await tempDir(t, 'jsonl-'), 'a.jsonl');
  await writeFile(path, '\n');
  await utimes(path, 1000, 1000); // epoch seconds: mtimeMs 1_000_000
  assert.deepEqual([await writtenSince(LOCAL, path, 1_000_000), await writtenSince(LOCAL, path, 1_000_001), await writtenSince(LOCAL, `${path}.gone`, 0)], [true, false, false]);
});

test('every line a reader reads goes through the machine\'s readLines under TRANSCRIPT_MAX_BYTES; over its cap it rejects too_large (#161)', async (t) => {
  const path = join(await tempDir(t, 'jsonl-'), 'a.jsonl');
  await writeFile(path, 'one\ntwo\n');
  const local = fakeMachine();
  const caps: number[] = [];
  const capped: Pick<Machine, 'fs'> = { fs: { ...local.fs, readLines: (file, { maxBytes }) => { caps.push(maxBytes); return local.fs.readLines(file, { maxBytes: 4 }); } } };
  const isTooLarge = (err: unknown): boolean => err instanceof MachineError && err.code === MachineError.TOO_LARGE;
  await assert.rejects(eachLine(capped, path, () => undefined), isTooLarge);
  await assert.rejects(firstLine(capped, path), isTooLarge);
  assert.deepEqual(caps, [TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_BYTES]);
});
