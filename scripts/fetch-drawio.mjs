// The draw.io webapp (#955): downloads the pinned draw.war, checks its SHA-256 and unpacks a pruned copy into vendor/drawio/, which git
// ignores and the /drawio/ route serves. Plain Node with no dependency, so install, build and CI run the same file on every OS: yauzl
// would be a new dependency, and the system's tar or unzip cannot open a zip on every Linux.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

// One place to bump: the release, its asset and the asset's SHA-256, recorded from the downloaded war
export const DRAWIO_PIN = Object.freeze({
  version: '32.6.10',
  url: 'https://github.com/jgraph/drawio/releases/download/v32.6.10/draw.war',
  sha256: 'a57b06b3b6a876a351dacfe65d027d9509319cd030e9bacf6ae04a034d66a38f',
});

// Path prefixes never inflated, from the v32.6.10 listing: what the embed (index.html?embed=1&offline=1) never loads; what is left is
// about 57.7 MB
export const PRUNED = Object.freeze([
  'WEB-INF/', 'META-INF/', 'templates/', // the servlet's own files and the diagram templates
  'connect/', // the Atlassian Connect add-on
  'js/diagramly/', 'js/grapheditor/', // the unminified sources: only dev=1 loads them, production loads js/app.min.js
  'js/integrate.min.js', 'js/viewer.min.js', 'js/viewer-static.min.js', // the integration and viewer bundles
  'teams.html', 'onedrive3.html', 'monday-app-association.json', 'vsdxImporter.html', // the Teams, OneDrive and monday integrations, the VSDX importer
]);

const STAMP = '.hive-drawio';
const SKIP_ENV = 'HIVE_SKIP_DRAWIO';
const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const ZIP64_COUNT = 0xffff;
const ZIP64_MARK = 0xffffffff;
const ENCRYPTED = 0x1;
const STORED = 0;
const DEFLATED = 8;

const fail = (message) => {
  throw new Error(`draw.war: ${message}`);
};

// The central directory's place: the end record sits in the last 22 bytes before a comment of at most 64 KiB
function directory(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT);
  let end = buffer.length - EOCD_SIZE;
  while (end >= floor && buffer.readUInt32LE(end) !== EOCD) end -= 1;
  if (end < floor) fail('no end of central directory record');
  const zip64 = end >= ZIP64_LOCATOR_SIZE && buffer.readUInt32LE(end - ZIP64_LOCATOR_SIZE) === ZIP64_LOCATOR;
  const count = buffer.readUInt16LE(end + 10);
  const offset = buffer.readUInt32LE(end + 16);
  if (zip64 || count === ZIP64_COUNT || offset === ZIP64_MARK) fail('Zip64 archives are not supported');
  return { count, offset };
}

// The war is checksummed, but the reader must not be a zip-slip primitive if the pin is ever bumped carelessly
function checkName(name) {
  const unsafe = name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.split('/').includes('..');
  if (unsafe) fail(`unsafe entry name ${JSON.stringify(name)}`);
}

// ponytail: names are read as UTF-8 whatever flag bit 11 says; the war's names are ASCII, add CP437 if a pin ever carries another
function centralEntry(buffer, at) {
  if (buffer.readUInt32LE(at) !== CENTRAL) fail('bad central directory header');
  const flags = buffer.readUInt16LE(at + 8);
  const method = buffer.readUInt16LE(at + 10);
  const nameLength = buffer.readUInt16LE(at + 28);
  const name = buffer.toString('utf8', at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
  checkName(name);
  if (flags & ENCRYPTED) fail(`${name} is encrypted`);
  if (method !== STORED && method !== DEFLATED) fail(`${name} uses unsupported method ${method}`);
  const header = { name, method, crc: buffer.readUInt32LE(at + 16), packed: buffer.readUInt32LE(at + 20), size: buffer.readUInt32LE(at + 24), local: buffer.readUInt32LE(at + 42) };
  if ([header.packed, header.size, header.local].includes(ZIP64_MARK)) fail(`${name} needs Zip64, which is not supported`);
  const next = at + CENTRAL_SIZE + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  return { header, next };
}

// The sizes come from the central directory: a local header written with a data descriptor holds zeros there
function inflate(buffer, { name, method, crc, packed, size, local }) {
  if (buffer.readUInt32LE(local) !== LOCAL) fail(`${name} has no local header`);
  const start = local + LOCAL_SIZE + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const raw = buffer.subarray(start, start + packed);
  const data = method === DEFLATED ? inflateRawSync(raw) : raw;
  if (data.length !== size || crc32(data) !== crc) fail(`${name} fails its CRC-32`);
  return data;
}

/** The war's file entries, every name and method checked; bytes() inflates one on demand, so a pruned entry is never inflated. */
export function readZip(buffer) {
  const { count, offset } = directory(buffer);
  const entries = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    const { header, next } = centralEntry(buffer, at);
    at = next;
    if (!header.name.endsWith('/')) entries.push({ name: header.name, bytes: () => inflate(buffer, header) });
  }
  return entries;
}

/** The entries the prune keeps. */
export const prunedEntries = (entries) => entries.filter(({ name }) => !PRUNED.some((prefix) => name.startsWith(prefix)));

// Every output path is resolved and must stay inside the staging folder, whatever checkName let through
function writeEntry(staging, entry) {
  const file = resolve(staging, entry.name);
  const inside = relative(staging, file);
  if (inside === '' || isAbsolute(inside) || inside.split(sep)[0] === '..') fail(`${entry.name} leaves the staging folder`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, entry.bytes());
}

// Staged, then swapped in: a failed or interrupted run never leaves a half-unpacked webapp
function install(target, entries, stamp) {
  const staging = `${target}.tmp`;
  rmSync(staging, { recursive: true, force: true }); // a crashed run's leftovers
  try {
    mkdirSync(staging, { recursive: true });
    for (const entry of entries) writeEntry(staging, entry);
    writeFileSync(join(staging, STAMP), stamp);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}

function readStamp(target) {
  try {
    return readFileSync(join(target, STAMP), 'utf8').trim();
  } catch {
    return undefined; // never installed, or a folder from before the stamp: install again
  }
}

// 50 MB fits in memory and needs no temp file to clean up; fetch follows GitHub's redirect to the asset host
async function downloadWar(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** vendor/drawio/ under root holds the pinned webapp, pruned: downloaded only when its stamp does not name the pin. */
export async function fetchDrawio({ root, env = process.env, download = downloadWar, pin = DRAWIO_PIN }) {
  if (env[SKIP_ENV] === '1') return; // the test lanes: no network and no 50 MB per lane
  const target = join(root, 'vendor', 'drawio');
  const stamp = `${pin.version} ${pin.sha256}`;
  if (readStamp(target) === stamp) return;
  const war = await download(pin.url);
  const got = createHash('sha256').update(war).digest('hex');
  if (got !== pin.sha256) fail(`SHA-256 ${got} does not match the pinned ${pin.sha256}`);
  install(target, prunedEntries(readZip(war)), stamp);
}

if (import.meta.main) await fetchDrawio({ root: process.cwd() });
