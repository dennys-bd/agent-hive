import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord, memoryStats as statsOf } from '../src/memory-stats.js';
import type { MemoryEntry } from '../src/types.js';

// the route's way: each line parsed and kept for its workspace as it is read
const memoryStats = (lines: string[], workspace: string, entries: MemoryEntry[], now: number) =>
  statsOf(lines.flatMap((l) => memoryRecord(l, workspace) ?? []), entries, now);
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const line = (record: Record<string, unknown>): string => JSON.stringify({ schema_version: 1, level: 'info', ...record });
const ENTRIES: MemoryEntry[] = ['m-1', 'm-2'].map((id) => ({ id, kind: 'fact', text: 'x', origin: 'user', at: '2026-10-01T10:00:00.000Z', uses: 0 }));

test('counts the workspace\'s runs with memory in the last 7 days, their mean tokens, the current lessons cited, and the latest run with its session\'s citations; a bad line is skipped (#797)', () => {
  const lines = [
    line({ ts: '2026-09-27T12:00:00.000Z', event: 'run.spawned', workspace: 'hive', memory_ids: ['m-1'], memory_chars: 999, session_id: 's0' }), // 8 days ago
    line({ ts: '2026-10-01T12:00:00.000Z', event: 'run.spawned', workspace: 'hive', memory_ids: ['m-1'], memory_chars: 400, task: '7', stage: 'spec', session_id: 's1' }),
    line({ ts: '2026-10-02T12:00:00.000Z', event: 'run.spawned', workspace: 'site', memory_ids: ['m-1'], memory_chars: 4000, session_id: 's9' }),
    line({ ts: '2026-10-02T13:00:00.000Z', event: 'run.spawned', workspace: 'hive', worker: 1 }), // no memory
    '{"not json',
    line({ ts: '2026-10-03T12:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-1', session_id: 's1' }),
    line({ ts: '2026-10-03T13:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-9', session_id: 's2' }), // removed since
    line({ ts: '2026-10-03T14:00:00.000Z', event: 'memory.applied', workspace: 'site', id: 'm-2', session_id: 's9' }),
    line({ ts: '2026-10-04T12:00:00.000Z', event: 'run.spawned', workspace: 'hive', memory_ids: ['m-1', 'm-2'], memory_chars: 800, task: '8', stage: 'build', session_id: 's2' }),
    line({ ts: '2026-10-04T13:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-2', session_id: 's2' }),
    line({ ts: '2026-10-04T14:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-2', session_id: 's2' }),
  ];
  assert.deepEqual(memoryStats(lines, 'hive', ENTRIES, NOW), {
    runs: 2, cited: 2, tokensPerRun: 150, last: { at: '2026-10-04T12:00:00.000Z', task: '8', stage: 'build', cited: 1 },
  });
});

test('no records give no runs and no citations; a free session\'s run has no stage (#797)', () => {
  assert.deepEqual(memoryStats([], 'hive', ENTRIES, NOW), { runs: 0, cited: 0 });
  const free = line({ ts: '2026-10-05T11:00:00.000Z', event: 'run.spawned', workspace: 'hive', memory_ids: ['m-1'], memory_chars: 10, task: '3' });
  assert.deepEqual(memoryStats([free], 'hive', ENTRIES, NOW), { runs: 1, cited: 0, tokensPerRun: 3, last: { at: '2026-10-05T11:00:00.000Z', task: '3', cited: 0 } });
});

test('the latest run\'s cited count leaves out the same session\'s citations from before that run (#797)', () => {
  const lines = [
    line({ ts: '2026-10-04T10:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-1', session_id: 's1' }),
    line({ ts: '2026-10-04T12:00:00.000Z', event: 'run.spawned', workspace: 'hive', memory_ids: ['m-1', 'm-2'], memory_chars: 40, task: '8', session_id: 's1' }),
    line({ ts: '2026-10-04T13:00:00.000Z', event: 'memory.applied', workspace: 'hive', id: 'm-2', session_id: 's1' }),
  ];
  assert.equal(memoryStats(lines, 'hive', ENTRIES, NOW).last?.cited, 1);
});
