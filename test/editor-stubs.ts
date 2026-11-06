import { chmod, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { crc32, gzipSync } from 'node:zlib';
import { createInstaller, type Installer, type InstallerDeps } from '../src/editor-install.js';
import type { EditorInstallEvent } from '../src/types.js';
import { tempDir } from './temp-dir.js';

// The tools an install runs that the tests stub (#780): npm and go, so no test depends on them; tar and unzip are the host's own, over archives built here (#635).
export const STUBS: Record<string, string> = {
  node: '',
  npm: `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (!args.includes('--ignore-scripts')) { process.stderr.write('no --ignore-scripts\\n'); process.exit(9); }
for (const spec of args.slice(6)) {
  const dir = join(args[2], 'node_modules', spec.replace(/@latest$/, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');
}
`,
  go: `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const gopls = join(process.env.GOBIN, process.platform === 'win32' ? 'gopls.exe' : 'gopls');
mkdirSync(process.env.GOBIN, { recursive: true });
writeFileSync(gopls, '');
chmodSync(gopls, 0o755);
`,
};

// A stub as the platform runs it (#635): its body is this node's, behind a sh script or, on win32, a .cmd that the resolver finds by PATHEXT
export async function writeStub(bin: string, name: string, body: string): Promise<void> {
  const script = join(bin, `${name}.mjs`);
  await writeFile(script, body);
  if (process.platform === 'win32') return writeFile(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  await writeFile(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(join(bin, name), 0o755);
}

// What cmd.exe and node need on win32 besides PATH (#635); elsewhere the stubs' PATH is the whole env
const WIN32_ENV = ['SystemRoot', 'ComSpec', 'PATHEXT'];
const baseEnv = (): NodeJS.ProcessEnv => (process.platform === 'win32' ? Object.fromEntries(WIN32_ENV.map((name) => [name, process.env[name]])) : {});

const DOS_DATE_1980 = 0x21; // 1980-01-01, zip's epoch
const MADE_BY_UNIX = 0x0314; // with it, unzip restores the mode below
const MODE_755 = (0o100755 << 16) >>> 0;

/** A stored (uncompressed) zip of `entries`, every file 0755, as every unzip reads it (#635). */
export function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const [file, data] = [Buffer.from(name), Buffer.from(content)];
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(MADE_BY_UNIX, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(MODE_755, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, file, data);
    centrals.push(central, file);
    offset += local.length + file.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const BLOCK = 512;
const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

/** A gzipped ustar archive of `entries`, every file 0755 (#635). Names stay under 100 bytes. */
export function tarGzOf(entries: Record<string, string>): Buffer {
  const blocks = Object.entries(entries).flatMap(([name, content]) => {
    const data = Buffer.from(content);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100);
    header.write(octal(0o755, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
    header.write(octal(data.length, 12), 124); header.write(octal(0, 12), 136);
    header.write('        ', 148); // the checksum counts its own field as spaces
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${octal(header.reduce((sum, byte) => sum + byte, 0), 7)} `, 148);
    return [header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(2 * BLOCK)]));
}

/** Release asset `name`, holding `content` at `entry` (a path under the install folder, with /), in the format its name says (#635). */
export const assetBody = (name: string, entry: string, content: string): Buffer => {
  if (name.endsWith('.tar.gz')) return tarGzOf({ [entry]: content });
  return name.endsWith('.zip') ? zipOf({ [entry]: content }) : gzipSync(content);
};
export const json = (body: unknown) => (res: ServerResponse): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

export interface Rig { home: string; bin: string; base: string; events: EditorInstallEvent[]; installer: Installer; routes: Map<string, (res: ServerResponse) => void> }

/** An installer over a temp home, the stubs on its PATH (only the ones `tools` names), and a local server standing in for every registry. */
export async function rig(t: TestContext, tools: readonly string[] = Object.keys(STUBS), extra: Partial<InstallerDeps> = {}): Promise<Rig> {
  const home = await tempDir(t, 'editor-home-');
  const bin = await tempDir(t, 'editor-bin-');
  for (const name of tools) await writeStub(bin, name, STUBS[name]);
  const routes = new Map<string, (res: ServerResponse) => void>();
  const server = createServer((req, res) => { const route = routes.get(req.url ?? ''); if (route) route(res); else { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events: EditorInstallEvent[] = [];
  const installer = createInstaller({
    home, env: () => ({ ...baseEnv(), PATH: bin }), arch: 'arm64', onState: (event) => events.push(event), downloads: { allowHttp: true }, ...extra,
    registries: { npm: `${base}/npm`, github: `${base}/gh`, goproxy: `${base}/go`, openvsx: `${base}/ovsx` },
  });
  return { home, bin, base, events, installer, routes };
}

// Fresh stub scripts can take seconds to start while the whole suite spawns processes, so the wait is generous; a passing run does not pay it
const SETTLE_TRIES = 3000;

/** Waits until `id`'s last event is no longer installing, and answers it. */
export async function settled(r: Rig, id: string): Promise<EditorInstallEvent> {
  for (let i = 0; i < SETTLE_TRIES; i += 1) {
    const last = r.events.filter((e) => e.id === id).at(-1);
    if (last !== undefined && last.state.state !== 'installing') return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${id} never settled`);
}
