import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MachineFs } from '../src/machine.js';
import { stableFs } from '../src/wsl/stable-fs.js';
import { fakeMachine } from './fake-machine.js';

test('the WSL machine\'s readFile forwards every option it was called with to the link\'s fs, noFollow included (#882)', async () => {
  const asked: unknown[] = [];
  const readFile = (async (_path: string, options: unknown) => {
    asked.push(options);
    return Buffer.from('x');
  }) as unknown as MachineFs['readFile'];
  const fs = stableFs(async () => fakeMachine({ fs: { readFile } }));
  await fs.readFile('/home/u/a.html', { maxBytes: 8, noFollow: true });
  await fs.readFile('/home/u/a.html', { maxBytes: 8, noFollow: true, encoding: 'utf8' });
  await fs.readFile('/home/u/a.html', { maxBytes: 8 });
  assert.deepEqual(asked, [{ maxBytes: 8, noFollow: true }, { maxBytes: 8, noFollow: true, encoding: 'utf8' }, { maxBytes: 8 }]);
});
