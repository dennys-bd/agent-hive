// The plugins view's pure parts (#313): which items a section and a group show, an item's mark, its usage line. Compiled by the main tsc too,
// hence the .js imports.
import type { Catalogue } from '../../template-map.js';
import { deliveredName } from '../../template.js';
import type { CatalogueItem, ItemKind, ItemRead, ItemState, ItemVersion } from '../../types.js';
import { t } from '../i18n.js';

/** The Hive plugin's origin, as item-sources.ts names it; that module reads the disk, so the UI keeps its own copy. */
export const HIVE_ORIGIN = 'hive';
export const SECTIONS = ['skills', 'specialists', 'mcp', 'protocol'] as const;
export type Section = (typeof SECTIONS)[number];
export type ListSection = Extract<Section, 'skills' | 'specialists'>;
export const KIND_OF: Record<ListSection, ItemKind> = { skills: 'skill', specialists: 'specialist' };
export const sectionOf = (kind: ItemKind): ListSection => (kind === 'skill' ? 'skills' : 'specialists');
export const isListSection = (section: Section): section is ListSection => section === 'skills' || section === 'specialists';

/** What the centre shows (#313): a section's list, one item, one version's update (#325), or the mcp or protocol screen. */
export type PluginScreen =
  | { kind: 'list'; section: ListSection }
  | { kind: 'item'; id: string }
  | { kind: 'update'; id: string; version: string }
  | { kind: 'mcp' }
  | { kind: 'protocol' };
export interface ItemGroup { origin: string; items: CatalogueItem[] }

/** The item a screen shows (#325): its own, or the one whose version it updates; undefined for a list, mcp and protocol. */
export const itemIdOf = (screen: PluginScreen): string | undefined => (screen.kind === 'item' || screen.kind === 'update' ? screen.id : undefined);

/** The sidebar section a screen belongs to; an update's is its item's (#325); undefined for an item the catalogue no longer has. */
export function sectionOfScreen(screen: PluginScreen, items: readonly CatalogueItem[]): Section | undefined {
  if (screen.kind === 'list') return screen.section;
  if (screen.kind === 'mcp' || screen.kind === 'protocol') return screen.kind;
  const item = items.find((i) => i.id === screen.id);
  return item && sectionOf(item.kind);
}

/** The search (#313): the name or the description, case-insensitive; a blank query keeps every item. */
export function matches(item: CatalogueItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
}

/** A kind's items by origin (#313): hive first, then each workspace in config order. With a workspace filter only hive and that workspace:
 * every Hive item reaches every workspace, a workspace's own only it. A group with no item is left out. */
export function groupsOf(items: readonly CatalogueItem[], kind: ItemKind, workspaces: readonly string[], query = '', filter?: string): ItemGroup[] {
  const origins = [HIVE_ORIGIN, ...workspaces.filter((w) => w !== HIVE_ORIGIN && (filter === undefined || w === filter))];
  return origins
    .map((origin) => ({ origin, items: items.filter((i) => i.origin === origin && i.kind === kind && matches(i, query)) }))
    .filter((group) => group.items.length > 0);
}

export const countOf = (items: readonly CatalogueItem[], kind: ItemKind): number => items.filter((i) => i.kind === kind).length;

/** The sidebar's mark (#313, the handoff's `2 ↗`): the version count from two up, then ↗ for an item based on an external one; '' for neither. */
export function markOf(item: CatalogueItem): string {
  const count = item.versions.length >= 2 ? String(item.versions.length) : '';
  return [count, item.basedOn === undefined ? '' : '↗'].filter((part) => part !== '').join(' ');
}

// #338, decision 12: one line per origin; the sidebar's mark stays one ↗
export const basedOnTitle = ({ basedOn }: CatalogueItem): string | undefined =>
  basedOn?.map(({ name, repo, license }) => t('plugins.basedOn', { name, repo, license })).join('\n');

const NO_USAGE = '—';

/** The list's usage column (#313, decision 11): the stages first, then each caller by name, comma-joined; — for none. */
export function usageText(item: CatalogueItem, items: readonly CatalogueItem[]): string {
  if (item.usage.length === 0) return NO_USAGE;
  const nameOf = (id: string): string => items.find((i) => i.id === id)?.name ?? id;
  return item.usage.map((use) => (use.kind === 'stage' ? t('plugins.usage.stage', { stage: use.stage }) : t('plugins.usage.caller', { name: nameOf(use.id) }))).join(', ');
}

const MINE = 'mine'; // custom-store.ts's MINE: that module reads the disk

/** The version the editor opens until 3.6's selector (#319, decision 4): mine when the item has it, else its first, else the original. */
export const openVersionOf = (item: CatalogueItem): string | null =>
  item.versions.some((v) => v.name === MINE) ? MINE : (item.versions[0]?.name ?? null);

/** The file the editor opens first (#319): the one delivered as the item's main file, else the first. */
export function mainPathOf({ item, files }: ItemRead): string | undefined {
  const main = item.kind === 'skill' ? 'SKILL.md' : `${item.name}.md`;
  return files.find((file) => deliveredName(file.path) === main)?.path ?? files[0]?.path;
}

/** The map's catalogue (#319, decision 16): what a bare word in a text may name, a Hive item under the plugin's namespace. */
export function catalogueOf(items: readonly CatalogueItem[]): Catalogue {
  const nameOf = (item: CatalogueItem): string => (item.origin === HIVE_ORIGIN ? `hive:${item.name}` : item.name);
  return { skills: items.filter((i) => i.kind === 'skill').map(nameOf), agents: items.filter((i) => i.kind === 'specialist').map(nameOf) };
}

/** The head's "saved 14:31" (#319, decision 10): the time today, the short date before it on another day. */
export function savedLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${time}`;
}

const ORIGINAL = 'original'; // custom-versions.ts's ORIGINAL: a version.json's `from` for a copy of the original

/** The version the editor opens (#320, decision 9): the one the menu chose while the catalogue still lists it (null: the original, which a
 * user-created item has none of), else #319's openVersionOf. */
export function versionToOpen(item: CatalogueItem, chosen: string | null | undefined): string | null {
  if (chosen === null) return item.userCreated ? openVersionOf(item) : null;
  return chosen !== undefined && item.versions.some((v) => v.name === chosen) ? chosen : openVersionOf(item);
}

// The plugin's version today, which the catalogue does not carry: a version whose base is still the shipped original was stamped with it
// (custom-store.ts writes hiveVersion with the base it copies)
const shippedVersion = (item: CatalogueItem): string | undefined => item.versions.find((v) => !v.updateAvailable && v.hiveVersion !== undefined)?.hiveVersion;

/** The original's name in the actions (decision 11): the Hive's, or a workspace item's repository file (#319, decision 27). */
export const originalName = (item: CatalogueItem): string =>
  t(item.origin === HIVE_ORIGIN ? 'plugins.version.hiveOriginalBare' : 'plugins.version.repositoryFile');

/** The original's row, and the selector's label while it is open (decisions 3, 7): the plugin's version beside it when one is known. */
export function originalLabel(item: CatalogueItem): string {
  const shipped = item.origin === HIVE_ORIGIN ? shippedVersion(item) : undefined;
  return shipped === undefined ? originalName(item) : t('plugins.version.hiveOriginal', { version: shipped });
}

// decision 5: `original <hiveVersion>`, another version's name, or nothing for a user-created item's first version
function fromText({ from, hiveVersion }: ItemVersion): string | undefined {
  if (from === null) return undefined;
  if (from !== ORIGINAL) return t('plugins.version.fromVersion', { name: from });
  return hiveVersion === undefined ? t('plugins.version.fromOriginalBare') : t('plugins.version.fromOriginal', { version: hiveVersion });
}

/** A version's sub-line (decision 5): `edited <date> · from <from>`, the date read as the head's saved time. */
export function versionSubline(version: ItemVersion, now: Date = new Date()): string {
  const from = fromText(version);
  return [t('plugins.version.edited', { date: savedLabel(version.editedAt, now) }), ...(from === undefined ? [] : [from])].join(' · ');
}

/** A row of the version menu (#320, decisions 4–7); version null is the original. */
export interface VersionRow { version: string | null; label: string; state?: ItemState; workspaces: readonly string[]; sub?: string }

/** The menu's rows: the versions in catalogue order, then the original, which a user-created item has none of. */
export function versionRows(item: CatalogueItem, now: Date = new Date()): VersionRow[] {
  const versions = item.versions.map((v): VersionRow => ({
    version: v.name, label: v.name, state: v.updateAvailable ? 'update available' : 'customized', workspaces: v.workspaces, sub: versionSubline(v, now),
  }));
  if (item.userCreated) return versions;
  const sub = item.versions.length > 0 ? t('plugins.version.alwaysAvailable') : undefined; // decision 7: not editable once a version exists
  return [...versions, { version: null, label: originalLabel(item), workspaces: item.onOriginal, ...(sub === undefined ? {} : { sub }) }];
}

/** "use in…"'s workspaces (decision 12): every configured one for a Hive item, a workspace item's own only. */
export const assignableWorkspaces = (item: CatalogueItem, workspaces: readonly string[]): readonly string[] =>
  (item.origin === HIVE_ORIGIN ? workspaces.filter((w) => w !== HIVE_ORIGIN) : [item.origin]);

/** The version a workspace runs today: a version's name, null for the original, undefined for none. */
export function versionInUse(item: CatalogueItem, workspace: string): string | null | undefined {
  const used = item.versions.find((v) => v.workspaces.includes(workspace));
  if (used !== undefined) return used.name;
  return item.onOriginal.includes(workspace) ? null : undefined;
}
