// What the registries say (#780): the latest version of a server or a syntax package, and where to download it. Unauthenticated GETs: every
// registry and repository here is public. A lookup that fails throws; the listing turns that into no latest.
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { type Arch, type ServerDef, serverDef, syntaxDef } from './languages.js';
import type { InstallTarget } from './types.js';

export interface Registries { npm: string; github: string; goproxy: string; openvsx: string }
export const REGISTRIES: Registries = { npm: 'https://registry.npmjs.org', github: 'https://api.github.com', goproxy: 'https://proxy.golang.org', openvsx: 'https://open-vsx.org/api' };
/** A latest version and, for a download kind, its file's URL. */
export interface Latest { version: string; url?: string }

const USER_AGENT = 'agent-hive'; // GitHub refuses an API call without one
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const stripV = (version: string): string => version.replace(/^v/, '');

export async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`GET ${url}: not an object`);
  return body;
}

export function stringAt(body: Record<string, unknown>, key: string, url: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new Error(`GET ${url}: no ${key}`);
  return value;
}

async function npmLatest(pkg: string, registries: Registries, signal?: AbortSignal): Promise<Latest> {
  const url = `${registries.npm}/${encodeURIComponent(pkg)}/latest`;
  return { version: stringAt(await getJson(url, signal), 'version', url) };
}

async function goLatest(module: string, registries: Registries, signal?: AbortSignal): Promise<Latest> {
  const url = `${registries.goproxy}/${module}/@latest`;
  return { version: stripV(stringAt(await getJson(url, signal), 'Version', url)) };
}

async function githubLatest(def: ServerDef, registries: Registries, arch: Arch, signal?: AbortSignal): Promise<Latest> {
  const url = `${registries.github}/repos/${def.source}/releases/latest`;
  const body = await getJson(url, signal);
  const version = stripV(stringAt(body, 'tag_name', url));
  const name = def.asset?.(version, arch) ?? '';
  const asset = (Array.isArray(body.assets) ? body.assets : []).filter(isRecord).find((a) => a.name === name);
  if (asset === undefined || typeof asset.browser_download_url !== 'string') throw new Error(`${def.source} ${version} has no asset ${name}`);
  return { version, url: asset.browser_download_url };
}

async function openVsxLatest(target: Extract<InstallTarget, { kind: 'syntax' }>, registries: Registries, signal?: AbortSignal): Promise<Latest> {
  const { namespace, name } = syntaxDef(target.id);
  const url = `${registries.openvsx}/${namespace}/${name}/latest`;
  const body = await getJson(url, signal);
  const files = isRecord(body.files) ? body.files : {};
  if (typeof files.download !== 'string') throw new Error(`GET ${url}: no files.download`);
  return { version: stringAt(body, 'version', url), url: files.download };
}

function lookup(target: InstallTarget, registries: Registries, arch: Arch, signal?: AbortSignal): Promise<Latest> {
  if (target.kind === 'syntax') return openVsxLatest(target, registries, signal);
  const def = serverDef(target.id);
  if (def.install === 'npm') return npmLatest(def.source, registries, signal);
  if (def.install === 'toolchain') return goLatest(def.source, registries, signal);
  return githubLatest(def, registries, arch, signal);
}

// A version ends up in a file name and a path (a release asset's name, installed.json): whatever a registry answers, it is never a path
const SAFE_VERSION = /^[\w.+-]+$/;

/** The latest version of `target` (#780) and, for a download kind, the URL its install downloads. */
export async function latestOf(target: InstallTarget, registries: Registries, arch: Arch, signal?: AbortSignal): Promise<Latest> {
  const latest = await lookup(target, registries, arch, signal);
  if (!SAFE_VERSION.test(latest.version)) throw new Error(`${target.id}: the registry's version is not a plain version`);
  return latest;
}

export interface DownloadLimits { allowHttp?: boolean; maxBytes?: number; idleMs?: number; totalMs?: number }
export const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 30_000; // no byte for this long: the connection is dead
const DOWNLOAD_TOTAL_MS = 10 * 60_000;

/** `url` into `file` (#780), the percent of its content-length reported each time it moves; aborting `signal` stops it. Only https (a redirect
 * included), at most `maxBytes`, and it ends when no byte comes for `idleMs` or the whole takes more than `totalMs`. */
export async function download(url: string, file: string, signal: AbortSignal, onPercent: (percent: number) => void, limits: DownloadLimits = {}): Promise<void> {
  const { allowHttp = false, maxBytes = DOWNLOAD_MAX_BYTES, idleMs = DOWNLOAD_IDLE_MS, totalMs = DOWNLOAD_TOTAL_MS } = limits;
  const isSecure = (address: string): boolean => allowHttp || new URL(address).protocol === 'https:';
  if (!isSecure(url)) throw new Error(`${url}: not an https URL`);
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(new Error('the download stalled')), idleMs);
  const any = AbortSignal.any([signal, idle.signal, AbortSignal.timeout(totalMs)]);
  try {
    const res = await fetch(url, { signal: any, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok || res.body === null) throw new Error(`GET ${url}: ${res.status}`);
    if (!isSecure(res.url)) throw new Error(`${url}: redirected to a URL that is not https`);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (total > maxBytes) throw new Error(`${url}: ${total} bytes, over the ${maxBytes} cap`);
    let received = 0;
    let shown = -1;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(new Error('the download stalled')), idleMs);
        received += chunk.length;
        if (received > maxBytes) return done(new Error(`${url}: over the ${maxBytes} bytes cap`));
        // no content-length: nothing to measure, so no percent (the page shows an indeterminate bar)
        const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : undefined;
        if (percent !== undefined && percent !== shown) { shown = percent; onPercent(percent); }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), counter, createWriteStream(file), { signal: any });
  } catch (err) {
    throw signal.aborted ? err : (any.reason instanceof Error ? any.reason : err); // a stall or the total's timeout says so, not "aborted"
  } finally {
    clearTimeout(timer);
  }
}
