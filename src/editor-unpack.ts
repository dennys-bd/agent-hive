// Each install kind's steps (#780), filling the temp folder the installer renames into place: npm into a prefix, go install into GOBIN, a
// GitHub asset unpacked, a .vsix's data files extracted. Every step is a program with argv, run through ctx.run.
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Latest } from './editor-fetch.js';
import type { Arch, ServerDef } from './languages.js';

export interface StepContext {
  tmp: string; // the temp folder the install fills
  arch: Arch;
  env: NodeJS.ProcessEnv; // the daemon's (#780)
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string>; // stdout; stderr goes to the log; a failure throws its last line
  download(url: string, file: string): Promise<void>;
}

// A package that carries its own spec (typescript@6) is installed as written; a bare name gets @latest
const withVersion = (pkg: string): string => (pkg.indexOf('@', 1) > 0 ? pkg : `${pkg}@latest`);

/** npm's packages into the temp prefix (#780), without their install scripts (none of the catalog's servers needs one: catalog-check.md); the version is the one npm put there. */
export async function npmStep(def: ServerDef, ctx: StepContext): Promise<string> {
  const packages = def.packages ?? [def.source];
  await ctx.run('npm', ['install', '--prefix', ctx.tmp, '--no-audit', '--no-fund', '--ignore-scripts', ...packages.map(withVersion)]);
  const manifest: unknown = JSON.parse(await readFile(join(ctx.tmp, 'node_modules', def.source, 'package.json'), 'utf8'));
  const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
  if (typeof version !== 'string') throw new Error(`${def.source}: no version in its package.json`);
  return version;
}

/** go install of the module into the temp folder's bin (#780); the version is the proxy's latest, looked up just before. */
export async function toolchainStep(def: ServerDef, latest: Latest, ctx: StepContext): Promise<string> {
  await ctx.run('go', ['install', `${def.source}@latest`], { ...ctx.env, GOBIN: join(ctx.tmp, 'bin') });
  return latest.version;
}

const GZ = '.gz';

// A lone binary: gunzip leaves it beside the .gz; it moves to bin/<binary> and becomes executable
async function gunzipBinary(file: string, binary: string, ctx: StepContext): Promise<void> {
  await ctx.run('gunzip', [file]);
  const bin = join(ctx.tmp, 'bin');
  await mkdir(bin, { recursive: true });
  await rename(file.slice(0, -GZ.length), join(bin, binary));
  await chmod(join(bin, binary), 0o755);
}

/** This Mac's release asset, downloaded and unpacked with the system's tar, unzip or gunzip (#780). */
export async function githubStep(def: ServerDef, latest: Latest, ctx: StepContext): Promise<string> {
  const asset = def.asset?.(latest.version, ctx.arch) ?? '';
  if (latest.url === undefined || asset === '') throw new Error(`${def.id}: no asset to download`);
  const file = join(ctx.tmp, asset);
  await ctx.download(latest.url, file);
  if (asset.endsWith('.tar.gz')) await ctx.run('tar', ['-xzf', file, '-C', ctx.tmp]);
  else if (asset.endsWith('.zip')) await ctx.run('unzip', ['-q', file, '-d', ctx.tmp]);
  else if (asset.endsWith(GZ)) await gunzipBinary(file, def.binaries[0], ctx);
  else throw new Error(`${asset}: not a .tar.gz, .zip or .gz`);
  await rm(file, { force: true });
  return latest.version;
}

const MANIFEST = 'extension/package.json';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const pathsAt = (list: unknown, key: string): string[] =>
  (Array.isArray(list) ? list : []).flatMap((entry) => (isRecord(entry) && typeof entry[key] === 'string' ? [entry[key] as string] : []));

/** The data files a package's manifest names (#780): each grammar's path and each language's configuration. */
export function dataFiles(manifest: unknown): { grammars: string[]; configurations: string[] } {
  const contributes = isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes : {};
  return { grammars: pathsAt(contributes.grammars, 'path'), configurations: pathsAt(contributes.languages, 'configuration') };
}

/** A manifest path as its .vsix entry (#780): under extension/ once normalised, or refused. */
export function inExtension(path: string): string {
  if (/[*?[\]\\]/.test(path)) throw new Error(`${path}: has a character unzip reads as a wildcard`); // unzip globs its names
  const entry = posix.normalize(posix.join('extension', path));
  if (!entry.startsWith('extension/') || entry.split('/').includes('..')) throw new Error(`${path}: leaves extension/`);
  return entry;
}

/** A .vsix's package.json and the files it names, nothing else (#780): no code of the extension is ever extracted. */
export async function openVsxStep(latest: Latest, ctx: StepContext): Promise<string> {
  if (latest.url === undefined) throw new Error('no .vsix to download');
  const vsix = join(ctx.tmp, 'package.vsix');
  await ctx.download(latest.url, vsix);
  const entries = new Set((await ctx.run('unzip', ['-Z1', vsix])).split('\n').map((e) => e.trim()));
  const { grammars, configurations } = dataFiles(JSON.parse(await ctx.run('unzip', ['-p', vsix, MANIFEST])));
  if (grammars.length === 0) throw new Error('the package names no grammar');
  const paths = [...new Set([...grammars, ...configurations].map(inExtension))];
  const missing = paths.find((p) => !entries.has(p));
  if (missing !== undefined) throw new Error(`${missing}: named in package.json, not in the .vsix`);
  await ctx.run('unzip', ['-q', vsix, MANIFEST, ...paths, '-d', ctx.tmp]);
  await rm(vsix, { force: true });
  return latest.version;
}
