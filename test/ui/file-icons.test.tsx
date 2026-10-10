// #754: the two icon sets resolve against the real packages. vitest runs through Vite, so the globs and the dynamic imports load them; no stub.
import { icons as VSCODE } from '@iconify-json/vscode-icons';
import { expect, test } from 'vitest';
import { type IconQuery, loadIconSet } from '@/lib/file-icons';
import { MANIFEST } from '@/lib/file-icons-material';
import { vscodeIconUrl } from '@/lib/file-icons-vscode';

const file = (name: string, theme: IconQuery['theme'] = 'dark'): IconQuery => ({ name, isFolder: false, isOpen: false, theme });
const folder = (name: string, isOpen: boolean): IconQuery => ({ name, isFolder: true, isOpen, theme: 'dark' });
const SVG_URL = 'data:image/svg+xml,';
const svgOf = (url: string): string => decodeURIComponent(url.slice(SVG_URL.length));

test('Material finds a file by its name, then its longest extension, then its language id, else the generic file (#754)', async () => {
  const resolve = await loadIconSet('material');
  expect(resolve(file('package.json'))).toContain('/nodejs.svg');
  expect(resolve(file('x.d.ts'))).toContain('/typescript-def.svg');
  expect(resolve(file('x.ts'))).toContain('/typescript.svg');
  expect(resolve(file('x.json'))).toContain('/json.svg');
  expect(resolve(file('x.zzqq'))).toContain('/file.svg');
  expect(resolve(file('constructor'))).toContain('/file.svg'); // an Object.prototype key is no file name
});

test('Material finds a folder by its name, open or closed, else the generic folder (#754)', async () => {
  const resolve = await loadIconSet('material');
  expect(resolve(folder('src', false))).toContain('/folder-src.svg');
  expect(resolve(folder('SRC', true))).toContain('/folder-src-open.svg');
  expect(resolve(folder('zzqq', false))).toContain('/folder.svg');
  expect(resolve(folder('zzqq', true))).toContain('/folder-open.svg');
});

test('Material reads its light section first under a light theme (#754)', async () => {
  const resolve = await loadIconSet('material');
  const [ext, icon] = Object.entries(MANIFEST.light?.fileExtensions ?? {})[0] ?? [];
  expect(ext).toBeDefined();
  const lightFile = MANIFEST.iconDefinitions[icon!].iconPath.split('/').at(-1);
  expect(resolve(file(`x.${ext}`, 'light'))).toContain(`/${lightFile}`);
  expect(resolve(file(`x.${ext}`, 'dark'))).not.toContain(`/${lightFile}`);
});

test('vscode-icons draws a file and a folder from the iconify JSON as an svg data: URL, unknown names on the default icons (#754)', async () => {
  const resolve = await loadIconSet('vscode');
  const ts = resolve(file('x.ts'));
  expect(ts.startsWith(SVG_URL)).toBe(true);
  expect(svgOf(ts)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+">/);
  expect(svgOf(ts)).toContain(VSCODE.icons['file-type-typescript'].body);
  expect(svgOf(ts).endsWith('</svg>')).toBe(true);
  expect(resolve(file('x.ts', 'light'))).toBe(ts); // no light map: the same icon on both themes
  expect(svgOf(resolve(file('x.zzqq')))).toContain(VSCODE.icons['default-file'].body);
  expect(svgOf(resolve(folder('src', false)))).toContain(VSCODE.icons['folder-type-src'].body);
  expect(svgOf(resolve(folder('src', true)))).toContain(VSCODE.icons['folder-type-src-opened'].body);
  expect(svgOf(resolve(folder('zzqq', false)))).toContain(VSCODE.icons['default-folder'].body);
});

test('a vscode-icons name the iconify JSON lacks falls back to the default icon it is given (#754)', () => {
  expect(vscodeIconUrl('folder_type_zzqq_opened.svg', 'default-folder-opened')).toBe(vscodeIconUrl('default_folder_opened.svg', 'default-folder'));
  expect(svgOf(vscodeIconUrl('default_folder_opened.svg', 'default-folder'))).toContain(VSCODE.icons['default-folder-opened'].body);
});

test('both sets give a row named after an Object.prototype key the default icon instead of throwing (#754)', async () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'a.constructor'];
  for (const set of ['vscode', 'material'] as const) {
    const resolve = await loadIconSet(set);
    for (const name of names) {
      expect(typeof resolve(file(name))).toBe('string');
      expect(typeof resolve(folder(name, false))).toBe('string');
      expect(typeof resolve(folder(name, true))).toBe('string');
    }
  }
  const vscode = await loadIconSet('vscode');
  expect(svgOf(vscode(file('constructor')))).toContain(VSCODE.icons['default-file'].body);
  expect(svgOf(vscode(folder('constructor', true)))).toContain(VSCODE.icons['default-folder-opened'].body);
});
