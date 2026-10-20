import type { CatalogueItem, ItemKind } from '../../../types';
import { OriginMark, STATE_LOOK, StateDot } from '@/components/plugins/marks';
import { NewItemField } from '@/components/plugins/NewItemField';
import type { Plugins } from '@/hooks/use-plugins';
import { t } from '@/i18n';
import { basedOnTitle, groupsOf, HIVE_ORIGIN, type ItemGroup, KIND_OF, type ListSection, usageText } from '@/lib/plugins';

const NO_ITEMS: CatalogueItem[] = [];
// The handoff's five columns: name, description, state, usage, external origin
const COLUMNS = 'grid grid-cols-[150px_minmax(0,1fr)_190px_170px_190px] items-center gap-4';
const KIND_PATH: Record<ItemKind, string> = { skill: '.claude/skills', specialist: '.claude/agents' }; // Claude Code's layout, a path in every language

function Row({ item, items, onOpen }: { item: CatalogueItem; items: readonly CatalogueItem[]; onOpen(): void }) {
  const look = STATE_LOOK[item.state];
  return (
    <li className="border-b last:border-b-0">
      <button type="button" onClick={onOpen} className={`${COLUMNS} w-full px-3.5 py-2.5 text-left text-[13px] hover:bg-accent/60`}>
        <span className="truncate font-medium font-mono">{item.name}</span>
        <span className="truncate text-muted-foreground">{item.description}</span>
        <span className={`flex items-center gap-1.5 text-xs ${look.text}`}><StateDot state={item.state} isDecorative />{t(look.label)}</span>
        <span className="text-muted-foreground text-xs">{usageText(item, items)}</span>
        <span title={basedOnTitle(item)} className="truncate text-muted-foreground text-xs">{item.basedOn ? `↗ ${item.basedOn.map((origin) => origin.name).join(', ')}` : ''}</span>
      </button>
    </li>
  );
}

function ListGroup({ group, kind, items, onOpen }: { group: ItemGroup; kind: ItemKind; items: readonly CatalogueItem[]; onOpen(id: string): void }) {
  const path = group.origin === HIVE_ORIGIN ? t('plugins.list.hivePath') : KIND_PATH[kind];
  return (
    <fieldset aria-label={group.origin} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <OriginMark origin={group.origin} /><span className="font-medium text-foreground">{group.origin}</span><span className="font-mono">{path}</span>
      </div>
      <ul className="flex flex-col rounded-lg border">{group.items.map((item) => <Row key={item.id} item={item} items={items} onOpen={() => onOpen(item.id)} />)}</ul>
    </fieldset>
  );
}

/** Screen 11a (#313): a section's items grouped as the sidebar groups them, narrowed by the head's workspace filter and the search; the new-item
 * field on top while it is open. A row opens its item. */
export function ListScreen({ plugins, section, workspaces }: { plugins: Plugins; section: ListSection; workspaces: readonly string[] }) {
  const items = plugins.items ?? NO_ITEMS;
  const kind = KIND_OF[section];
  return (
    <section aria-label={t(`plugins.section.${section}`)} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      {plugins.isCreating && (
        <NewItemField kind={kind} workspaces={workspaces} initialOrigin={plugins.filter ?? HIVE_ORIGIN} onCreate={plugins.create} onCancel={() => plugins.setCreating(false)} />
      )}
      {groupsOf(items, kind, workspaces, plugins.query, plugins.filter).map((group) => (
        <ListGroup key={group.origin} group={group} kind={kind} items={items} onOpen={(id) => plugins.open({ kind: 'item', id })} />
      ))}
    </section>
  );
}
