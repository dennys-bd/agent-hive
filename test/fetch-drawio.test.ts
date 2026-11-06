import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type * as FetchDrawio from '../scripts/fetch-drawio.mjs';
import { tempDir } from './temp-dir.js';

// .mjs files are not copied to dist/: this file, run from dist/test/, climbs back to the repo's scripts/ (#624)
const { DRAWIO_PIN, PRUNED, fetchDrawio, prunedEntries, readZip }: typeof FetchDrawio = await import(new URL('../../scripts/fetch-drawio.mjs', import.meta.url).href);

type Field = readonly [at: number, width: 2 | 4, value: number];
interface Entry { name: string; data?: string; method?: number; crc?: number; flags?: number }

const KEPT: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>draw.io</title>', 'js/app.min.js': 'var app = 1;\n', 'styles/grapheditor.css': '.geEditor {}\n',
};
const PRUNED_NAMES = ['WEB-INF/web.xml', 'META-INF/MANIFEST.MF', 'templates/basic/flow.xml'];

// A zip header: its fixed size and its fields, every other byte zero
function header(size: number, fields: readonly Field[]): Buffer {
  const bytes = Buffer.alloc(size);
  for (const [at, width, value] of fields) {
    if (width === 2) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt32LE(value, at);
  }
  return bytes;
}

// A war built in the test: stored (0) or deflated (8) entries, their local headers, the central directory and its end record. A central
// header's shared fields sit two bytes after the local header's
function zipOf(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data = '', method = 8, flags = 0, crc } of entries) {
    const raw = Buffer.from(data);
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const path = Buffer.from(name);
    const shared: Field[] = [[6, 2, flags], [8, 2, method], [14, 4, crc ?? crc32(raw)], [18, 4, packed.length], [22, 4, raw.length], [26, 2, path.length]];
    parts.push(header(30, [[0, 4, 0x04034b50], ...shared]), path, packed);
    central.push(header(46, [[0, 4, 0x02014b50], ...shared.map(([at, width, value]): Field => [at + 2, width, value]), [42, 4, offset]]), path);
    offset += 30 + path.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = header(22, [[0, 4, 0x06054b50], [8, 2, entries.length], [10, 2, entries.length], [12, 4, directory.length], [16, 4, offset]]);
  return Buffer.concat([...parts, directory, end]);
}

const warOf = (extra: readonly Entry[] = []): Buffer => zipOf([
  { name: 'index.html', data: KEPT['index.html'], method: 0 },
  { name: 'js/', method: 0 },
  { name: 'js/app.min.js', data: KEPT['js/app.min.js'] },
  { name: 'styles/grapheditor.css', data: KEPT['styles/grapheditor.css'] },
  ...PRUNED_NAMES.map((name) => ({ name, data: 'pruned\n' })),
  ...extra,
]);
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const pinOf = (war: Buffer, version = '0.0.1'): FetchDrawio.DrawioPin => ({ version, url: `https://example.invalid/v${version}/draw.war`, sha256: sha256(war) });

function served(war: Buffer): { download: (url: string) => Promise<Buffer>; asked: string[] } {
  const asked: string[] = [];
  return { asked, download: async (url) => { asked.push(url); return war; } };
}

const vendor = (root: string, name: string): string => join(root, 'vendor', name);

test('the pin is v32.6.10\'s release asset with a recorded SHA-256, and the prune drops the servlet\'s files and the templates (#955)', () => {
  assert.equal(DRAWIO_PIN.version, '32.6.10');
  assert.equal(DRAWIO_PIN.url, 'https://github.com/jgraph/drawio/releases/download/v32.6.10/draw.war');
  assert.match(DRAWIO_PIN.sha256, /^[0-9a-f]{64}$/, 'the value Task 1 recorded, not a placeholder');
  for (const prefix of ['WEB-INF/', 'META-INF/', 'templates/']) assert.ok(PRUNED.includes(prefix), prefix);
});

test('a war matching the pin unpacks its kept entries, stored and deflated, into vendor/drawio/ with the stamp, and none of the pruned prefixes (#955)', async (t) => {
  const root = await tempDir(t, 'drawio-');
  const war = warOf();
  const pin = pinOf(war);
  const { download, asked } = served(war);
  await fetchDrawio({ root, env: {}, download, pin });
  assert.deepEqual(asked, [pin.url]);
  for (const [name, text] of Object.entries(KEPT)) assert.equal(readFileSync(join(vendor(root, 'drawio'), name), 'utf8'), text, name);
  assert.equal(readFileSync(join(vendor(root, 'drawio'), '.hive-drawio'), 'utf8'), `${pin.version} ${pin.sha256}`);
  for (const top of ['WEB-INF', 'META-INF', 'templates']) assert.equal(existsSync(join(vendor(root, 'drawio'), top)), false, top);
  assert.equal(existsSync(vendor(root, 'drawio.tmp')), false);
});

test('a second run with the same pin downloads nothing; a new pin replaces the whole folder (#955)', async (t) => {
  const root = await tempDir(t, 'drawio-');
  const first = warOf([{ name: 'js/old.js', data: 'old\n' }]);
  await fetchDrawio({ root, env: {}, download: served(first).download, pin: pinOf(first) });
  const again = served(first);
  await fetchDrawio({ root, env: {}, download: again.download, pin: pinOf(first) });
  assert.deepEqual(again.asked, []);
  const next = warOf();
  const bumped = served(next);
  await fetchDrawio({ root, env: {}, download: bumped.download, pin: pinOf(next, '0.0.2') });
  assert.equal(bumped.asked.length, 1);
  assert.equal(existsSync(join(vendor(root, 'drawio'), 'js', 'old.js')), false, 'nothing of the old install survives');
  assert.match(readFileSync(join(vendor(root, 'drawio'), '.hive-drawio'), 'utf8'), /^0\.0\.2 /);
});

test('a war with another SHA-256 throws naming draw.war, and neither vendor/drawio/ nor vendor/drawio.tmp/ exists (#955)', async (t) => {
  const root = await tempDir(t, 'drawio-');
  const war = warOf();
  const pin = { ...pinOf(war), sha256: '0'.repeat(64) };
  await assert.rejects(fetchDrawio({ root, env: {}, download: served(war).download, pin }), /^Error: draw\.war: SHA-256 [0-9a-f]{64} does not match the pinned 0{64}$/);
  assert.equal(existsSync(vendor(root, 'drawio')), false);
  assert.equal(existsSync(vendor(root, 'drawio.tmp')), false);
});

test('an absolute, drive-letter, backslashed or .. entry name throws before anything is written (#955)', async (t) => {
  for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'js/../../x']) {
    assert.throws(() => readZip(zipOf([{ name, data: 'x' }])), /draw\.war: unsafe entry name/, name);
  }
  const root = await tempDir(t, 'drawio-');
  const war = warOf([{ name: '../../x', data: 'escaped\n' }]);
  await assert.rejects(fetchDrawio({ root, env: {}, download: served(war).download, pin: pinOf(war) }), /unsafe entry name/);
  for (const path of [join(root, 'x'), vendor(root, 'x'), vendor(root, 'drawio'), vendor(root, 'drawio.tmp')]) assert.equal(existsSync(path), false, path);
});

test('an unsupported method or an encrypted entry throws on reading the directory; a CRC mismatch throws on inflating and leaves no folder behind (#955)', async (t) => {
  assert.throws(() => readZip(zipOf([{ name: 'a.txt', data: 'x', method: 9 }])), /a\.txt uses unsupported method 9/);
  assert.throws(() => readZip(zipOf([{ name: 'a.txt', data: 'x', flags: 1 }])), /a\.txt is encrypted/);
  const bad: Entry = { name: 'js/bad.js', data: 'bad\n', crc: (crc32(Buffer.from('bad\n')) ^ 1) >>> 0 };
  assert.throws(() => readZip(zipOf([bad])).map((entry) => entry.bytes()), /js\/bad\.js fails its CRC-32/);
  const root = await tempDir(t, 'drawio-');
  const war = warOf([bad]);
  await assert.rejects(fetchDrawio({ root, env: {}, download: served(war).download, pin: pinOf(war) }), /CRC-32/);
  assert.equal(existsSync(vendor(root, 'drawio')), false);
  assert.equal(existsSync(vendor(root, 'drawio.tmp')), false, 'the staging folder of a failed run is removed');
});

test('prunedEntries keeps what no pruned prefix starts and inflates nothing: a pruned entry with a bad CRC never throws (#955)', () => {
  const entries = readZip(zipOf([{ name: 'index.html', data: 'x' }, { name: 'WEB-INF/web.xml', data: 'y', crc: 1 }, { name: 'js/', method: 0 }]));
  assert.deepEqual(entries.map((entry) => entry.name), ['index.html', 'WEB-INF/web.xml'], 'a folder entry is no file');
  assert.deepEqual(prunedEntries(entries).map((entry) => entry.name), ['index.html']);
});

test('HIVE_SKIP_DRAWIO=1 returns without a request and writes nothing (#955)', async (t) => {
  const root = await tempDir(t, 'drawio-');
  const { download, asked } = served(warOf());
  await fetchDrawio({ root, env: { HIVE_SKIP_DRAWIO: '1' }, download, pin: pinOf(warOf()) });
  assert.deepEqual(asked, []);
  assert.equal(existsSync(join(root, 'vendor')), false);
});

test('a truncated or garbage buffer throws draw.war\'s own error, never a raw RangeError (#955)', () => {
  for (const buffer of [Buffer.alloc(0), Buffer.from('PK'), Buffer.alloc(64, 7)]) {
    assert.throws(() => readZip(buffer), /^Error: draw\.war: no end of central directory record$/, `${buffer.length} bytes`);
  }
});
