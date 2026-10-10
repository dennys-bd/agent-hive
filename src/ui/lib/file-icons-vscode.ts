// vscode-icons (#754): vscode-icons-js names a row's icon, the iconify JSON draws it. In this chunk only: file-icons.ts imports it while
// vscode-icons is chosen. vscode-icons-js has no light map, so both themes show the same icons.
import { icons as ICON_SET } from '@iconify-json/vscode-icons';
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js';
import type { IconResolver } from '@/lib/file-icons';

const DEFAULT_SIZE = 16; // iconify's own default when neither the icon nor the set gives a width or height
const SVG_URL = 'data:image/svg+xml,';
const urls = new Map<string, string>(); // one encode per icon name for the page's life

// file_type_typescript.svg → file-type-typescript
const iconifyName = (file: string): string => file.replace(/\.svg$/, '').replaceAll('_', '-');

// The icon as a whole svg document in a data: URL, so the row renders it through <img> and no HTML string reaches the DOM
function svgUrl(name: string): string | undefined {
  const aliases = ICON_SET.aliases ?? {};
  const parent = Object.hasOwn(aliases, name) ? aliases[name].parent : undefined;
  const own = (key: string) => (Object.hasOwn(ICON_SET.icons, key) ? ICON_SET.icons[key] : undefined);
  const icon = own(name) ?? (parent === undefined ? undefined : own(parent));
  if (icon === undefined) return undefined;
  const width = icon.width ?? ICON_SET.width ?? DEFAULT_SIZE;
  const height = icon.height ?? ICON_SET.height ?? DEFAULT_SIZE;
  return SVG_URL + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`);
}

/** A vscode-icons file name's svg data: URL, else `fallback`'s (an iconify name): a stale map's name the JSON lacks gets the default icon. */
export function vscodeIconUrl(file: string, fallback: string): string {
  const name = iconifyName(file);
  const known = urls.get(name);
  if (known !== undefined) return known;
  const url = svgUrl(name) ?? svgUrl(fallback) ?? '';
  urls.set(name, url);
  return url;
}

// vscode-icons-js looks names up on plain objects, so a row named `constructor` or `__proto__` gets an inherited member back, or makes
// getIconForOpenFolder throw; any answer but a string is the default icon
function iconFile(lookup: () => unknown, fallback: string): string {
  try {
    const file = lookup();
    return typeof file === 'string' ? file : fallback;
  } catch {
    return fallback;
  }
}

/** vscode-icons' icon URL for a tree row. */
export const vscodeResolver: IconResolver = ({ name, isFolder, isOpen }) => {
  if (!isFolder) return vscodeIconUrl(iconFile(() => getIconForFile(name), 'default_file.svg'), 'default-file');
  if (isOpen) return vscodeIconUrl(iconFile(() => getIconForOpenFolder(name), 'default_folder_opened.svg'), 'default-folder-opened');
  return vscodeIconUrl(iconFile(() => getIconForFolder(name), 'default_folder.svg'), 'default-folder');
};
