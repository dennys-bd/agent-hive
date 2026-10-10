import { after, test } from 'node:test';
import { tempDir } from '../temp-dir.js';

// Run only by temp-dir.test.ts, in a child `node --test` (#428): it prints its two dirs and fails, and the parent checks both are gone.
// Not a *.test.ts, and one level down: the suite's own glob (dist/test/*.test.js) never picks it up.
const moduleDir = await tempDir({ after }, 'fixture-module-');
console.log(`TEMP_DIR=${moduleDir}`);

test('a test that fails after making a dir', async (t) => {
  console.log(`TEMP_DIR=${await tempDir(t, 'fixture-test-')}`);
  throw new Error('fails on purpose');
});
