import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { posixShell } from '../src/posix-shell.js';

const ENTRY = 'bin/server.js';

/** What npm installs beside .bin: the package's package.json naming `binary`'s script, and that script. win32 runs node on it (#635). A package
 *  with several binaries (vscode-langservers-extracted) is written once per binary: each call adds its entry to the bin map, never replaces it. */
export async function writeNpmEntry(dir: string, source: string, binary: string, body: string): Promise<void> {
  const pkg = join(dir, 'node_modules', ...source.split('/'));
  await mkdir(join(pkg, 'bin'), { recursive: true });
  const earlier = await readFile(join(pkg, 'package.json'), 'utf8').then((text) => (JSON.parse(text) as { bin: Record<string, string> }).bin, () => ({}));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: source, bin: { ...earlier, [binary]: ENTRY } }));
  await writeFile(join(pkg, ENTRY), body);
}

/** The script node runs for an npm server on this platform: the package's entry on win32, the .bin script elsewhere. */
export const npmScriptPath = (dir: string, source: string, binary: string): string => (process.platform === 'win32'
  ? join(dir, 'node_modules', ...source.split('/'), ...ENTRY.split('/'))
  : join(dir, 'node_modules', '.bin', binary));

/** A project's tool on win32 is found by PATHEXT (#632), so an extensionless sh script is missed: a .cmd beside it runs it through Git's sh. Elsewhere nothing. */
export async function writeCmdTwin(path: string): Promise<void> {
  if (process.platform === 'win32') await writeFile(`${path}.cmd`, `@"${posixShell().shell}" "${path}" %*\r\n`);
}
