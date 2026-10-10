// Material Icon Theme (#754): its manifest and every SVG's URL, in this chunk only; file-icons.ts imports it while Material is chosen.
// Read by path, not by package specifier, so the package's exports field never matters. exhaustive: a glob skips node_modules without it.
// no-inline: each SVG stays its own file the row's <img> fetches, instead of 1251 data: URLs inlined into this chunk.
import type { IconQuery, IconResolver } from '@/lib/file-icons';

type IconMap = Record<string, string>;
type MapKey = 'fileNames' | 'fileExtensions' | 'languageIds' | 'folderNames' | 'folderNamesExpanded';
type DefaultKey = 'file' | 'folder' | 'folderExpanded';
type Layer = Partial<Record<MapKey, IconMap> & Record<DefaultKey, string>>;
interface Manifest extends Layer { iconDefinitions: Record<string, { iconPath: string }>; light?: Layer }

const MANIFESTS = import.meta.glob<Manifest>('../../../node_modules/material-icon-theme/dist/material-icons.json', { eager: true, import: 'default', exhaustive: true });
const SVGS = import.meta.glob<string>('../../../node_modules/material-icon-theme/icons/*.svg', { eager: true, query: '?no-inline', import: 'default', exhaustive: true });

const found = Object.values(MANIFESTS)[0];
if (found === undefined) throw new Error('material-icon-theme: dist/material-icons.json not found'); // the import rejects; useFileIcons logs it
/** The theme's manifest as the package ships it; the tests read its light section. */
export const MANIFEST: Manifest = found;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const URLS: ReadonlyMap<string, string> = new Map(Object.entries(SVGS).map(([path, url]) => [baseName(path), url]));
const FALLBACK: Record<DefaultKey, string> = { file: 'file', folder: 'folder', folderExpanded: 'folder-open' };

// Own keys only: a file named "constructor" must not find Object.prototype's
const pick = (map: IconMap | undefined, key: string): string | undefined => (map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined);
// Under a light theme the light layer comes first, for each kind of match on its own, as VS Code applies an icon theme's light overrides
const lookup = (layers: readonly Layer[], key: MapKey, entry: string): string | undefined =>
  layers.map((layer) => pick(layer[key], entry)).find((icon) => icon !== undefined);

// x.d.ts → d.ts, ts: fileExtensions holds compound extensions, and the longest one wins
function suffixes(name: string): string[] {
  const parts = name.split('.').slice(1);
  return parts.map((_, i) => parts.slice(i).join('.'));
}

function fileIcon(layers: readonly Layer[], name: string): string | undefined {
  const exts = suffixes(name);
  const byExtension = exts.map((ext) => lookup(layers, 'fileExtensions', ext)).find((icon) => icon !== undefined);
  const last = exts.at(-1);
  // a few common extensions (json, css, html) are only in languageIds, under the language id that matches them
  return lookup(layers, 'fileNames', name) ?? byExtension ?? (last === undefined ? undefined : lookup(layers, 'languageIds', last));
}

function iconName({ name, isFolder, isOpen, theme }: IconQuery): string {
  const layers: Layer[] = theme === 'light' && MANIFEST.light !== undefined ? [MANIFEST.light, MANIFEST] : [MANIFEST];
  const lower = name.toLowerCase();
  const named = isFolder ? lookup(layers, isOpen ? 'folderNamesExpanded' : 'folderNames', lower) : fileIcon(layers, lower);
  if (named !== undefined) return named;
  const key: DefaultKey = isFolder ? (isOpen ? 'folderExpanded' : 'folder') : 'file';
  return layers.map((layer) => layer[key]).find((icon) => icon !== undefined) ?? FALLBACK[key];
}

// An icon name to its SVG's URL through the file name of its iconPath; an unknown one gets the generic file
function iconUrl(icon: string): string {
  const path = Object.hasOwn(MANIFEST.iconDefinitions, icon) ? MANIFEST.iconDefinitions[icon].iconPath : '';
  return URLS.get(baseName(path)) ?? URLS.get(`${FALLBACK.file}.svg`) ?? '';
}

/** Material's icon URL for a tree row. */
export const materialResolver: IconResolver = (query) => iconUrl(iconName(query));
