import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { ghExec } from '../src/sources/github-gql.js';
import { tempDir } from './temp-dir.js';

test('ghExec rejects, and the server survives, when gh exits before reading a large stdin body (#592)', async (t) => {
  const bin = await tempDir(t, 'gh-bin-');
  if (process.platform === 'win32') {
    // win32: an extensionless fake loses to the runner's gh.exe, which then asks for GH_TOKEN
    await writeFile(join(bin, 'gh.cmd'), '@echo boom 1>&2\r\n@exit /b 1\r\n');
  } else {
    await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "boom" >&2\nexit 1\n');
    await chmod(join(bin, 'gh'), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  t.after(() => { process.env.PATH = path; });
  await assert.rejects(ghExec(['api', 'graphql', '--input', '-'], 'x'.repeat(2 * 1024 * 1024)), /boom/);
  await new Promise((resolve) => setTimeout(resolve, 50)); // an EPIPE lands after the exit: an uncaught one fails the run
});
