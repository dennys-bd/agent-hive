// The plugins view's pure parts (#313): which items a section and a group show, an item's mark, its usage line. Compiled by the main tsc too,
// hence the .js imports.
import type { CatalogueItem, ItemKind } from '../../types.js';
import { t } from '../i18n.js';

/** The Hive plugin's origin, as item-sources.ts names it; that module reads the disk, so the UI keeps its own copy. */
export const HIVE_ORIGIN = 'hive';
export const SECTIONS = ['skills', 'specialists', 'mcp', 'protocol'] as const;
export type Section = (typeof SECTIONS)[number];
export type ListSection = Extract<Section, 'skills' | 'specialists'>;
export const KIND_OF: Record<ListSection, ItemKind> = { skills: 'skill', specialists: 'specialist' };
export const sectionOf = (kind: ItemKind): ListSection => (kind === 'skill' ? 'skills' : 'specialists');
export const isListSection = (section: Section): section is ListSection => section === 'skills' || section === 'specialists';

/** What the centre shows (#313): a section's list, one item, or the mcp or protocol screen. */
export type PluginScreen = { kind: 'list'; section: ListSection } | { kind: 'item'; id: string } | { kind: 'mcp' } | { kind: 'protocol' };
export interface ItemGroup { origin: string; items: CatalogueItem[] }

/** The sidebar section a screen belongs to; undefined for an item the catalogue no longer has. */
export function sectionOfScreen(screen: PluginScreen, items: readonly CatalogueItem[]): Section | undefined {
  if (screen.kind === 'list') return screen.section;
  if (screen.kind !== 'item') return screen.kind;
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

export const basedOnTitle = ({ basedOn }: CatalogueItem): string | undefined =>
  basedOn && t('plugins.basedOn', { name: basedOn.name, repo: basedOn.repo, license: basedOn.license });

const NO_USAGE = '—';

/** The list's usage column (#313, decision 11): the stages first, then each caller by name, comma-joined; — for none. */
export function usageText(item: CatalogueItem, items: readonly CatalogueItem[]): string {
  if (item.usage.length === 0) return NO_USAGE;
  const nameOf = (id: string): string => items.find((i) => i.id === id)?.name ?? id;
  return item.usage.map((use) => (use.kind === 'stage' ? t('plugins.usage.stage', { stage: use.stage }) : t('plugins.usage.caller', { name: nameOf(use.id) }))).join(', ');
}
