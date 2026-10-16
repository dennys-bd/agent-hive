import { type RefObject, useEffect, useRef } from 'react';
import type { CatalogueItem, ItemKind } from '../../../types';
import { displayBinding } from '../../../shortcuts.js';
import { LEGEND, OriginMark, STATE_LOOK, StateDot } from '@/components/plugins/marks';
import { Input } from '@/components/ui/input';
import type { Plugins } from '@/hooks/use-plugins';
import { t } from '@/i18n';
import { isSettingsClosed, onShortcutKey, type PanelId } from '@/lib/dock-layout';
import { basedOnTitle, countOf, groupsOf, isListSection, KIND_OF, markOf, type PluginScreen, type Section, SECTIONS, sectionOfScreen } from '@/lib/plugins';
import { binding, isMac } from '@/lib/shortcut-bindings';

export interface PluginsSidebarProps { plugins: Plugins; workspaces: readonly string[]; isShown: boolean; activate(id: PanelId): void }

const NO_ITEMS: CatalogueItem[] = [];
const ROW = 'flex w-full items-center gap-2 rounded-md px-2 text-left';
const screenOf = (section: Section): PluginScreen => (isListSection(section) ? { kind: 'list', section } : { kind: section });

function SearchField({ value, onChange, inputRef }: { value: string; onChange(value: string): void; inputRef: RefObject<HTMLInputElement | null> }) {
  const keys = binding('searchPlugins');
  return (
    <div className="relative">
      <Input ref={inputRef} type="search" aria-label={t('plugins.search')} placeholder={t('plugins.search')} value={value} onChange={(event) => onChange(event.target.value)} className="h-8 pr-10 text-sm" />
      {keys && <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tracking-widest">{displayBinding(keys, isMac())}</kbd>}
    </div>
  );
}

function ItemRow({ item, isOpen, onOpen }: { item: CatalogueItem; isOpen: boolean; onOpen(): void }) {
  const mark = markOf(item);
  return (
    <button type="button" aria-current={isOpen || undefined} onClick={onOpen} className={`${ROW} py-1 text-[13px] ${isOpen ? 'bg-accent' : 'hover:bg-accent/60'}`}>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.name}</span>
      {mark !== '' && <span title={basedOnTitle(item)} className="text-[11px] text-muted-foreground">{mark}</span>}
      <StateDot state={item.state} />
    </button>
  );
}

// The open section's items by origin (decision 7), searched as the user types (decision 4)
function Groups({ plugins, items, kind, workspaces }: { plugins: Plugins; items: CatalogueItem[]; kind: ItemKind; workspaces: readonly string[] }) {
  const { screen } = plugins;
  return groupsOf(items, kind, workspaces, plugins.query).map((group) => (
    <fieldset key={group.origin} aria-label={group.origin} className="flex min-w-0 flex-col gap-px pt-1.5 pl-2">
      <div className="flex items-center gap-1.5 px-2 pb-0.5 text-[11px] text-muted-foreground"><OriginMark origin={group.origin} />{group.origin}</div>
      {group.items.map((item) => (
        <ItemRow key={item.id} item={item} isOpen={screen.kind === 'item' && screen.id === item.id} onOpen={() => plugins.open({ kind: 'item', id: item.id })} />
      ))}
    </fieldset>
  ));
}

interface SectionProps { section: Section; plugins: Plugins; workspaces: readonly string[]; isActive: boolean }

// A section and its count (decision 6: mcp and protocol have no data yet, and none before the first read); its groups while one of its items
// is open. On the list screen the side holds the sections alone, as the handoff's 11a: the list in the centre already shows every item
function SectionBlock({ section, plugins, workspaces, isActive }: SectionProps) {
  const items = plugins.items ?? NO_ITEMS;
  const count = plugins.items !== undefined && isListSection(section) ? countOf(items, KIND_OF[section]) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <button type="button" aria-current={isActive || undefined} onClick={() => plugins.open(screenOf(section))} className={`${ROW} py-1.5 font-medium text-[13px] ${isActive ? 'bg-accent' : 'hover:bg-accent/60'}`}>
        <span className="flex-1">{t(`plugins.section.${section}`)}</span>
        {count !== undefined && <span className="font-normal text-muted-foreground text-xs">{count}</span>}
      </button>
      {isActive && isListSection(section) && plugins.screen.kind === 'item' && <Groups plugins={plugins} items={items} kind={KIND_OF[section]} workspaces={workspaces} />}
    </div>
  );
}

function Legend() {
  return (
    <ul aria-label={t('plugins.legend')} className="flex flex-col gap-1 px-2 text-[11px] text-muted-foreground">
      {LEGEND.map((state) => <li key={state} className="flex items-center gap-1.5"><StateDot state={state} isDecorative />{t(STATE_LOOK[state].label)}</li>)}
    </ul>
  );
}

/** The plugins view's left column (#313): the search, the four sections with their counts, the open section's items by origin, the legend. */
export function PluginsSidebar({ plugins, workspaces, isShown, activate }: PluginsSidebarProps) {
  const search = useRef<HTMLInputElement>(null);
  // The sidebar stays mounted, collapsed, under the other views: its ⌘F acts only while the view is shown, opening a closed side first
  useEffect(() => (isShown ? onShortcutKey([[true, 'searchPlugins']], () => {
    activate('plugins');
    search.current?.focus();
  }, isSettingsClosed) : undefined), [isShown, activate]);
  const active = sectionOfScreen(plugins.screen, plugins.items ?? NO_ITEMS);
  return (
    <nav aria-label={t('dock.plugins')} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3">
      <SearchField inputRef={search} value={plugins.query} onChange={plugins.setQuery} />
      {plugins.hasFailed && <p role="alert" className="px-2 text-destructive text-xs">{t('plugins.loadFailed')}</p>}
      <div className="flex flex-col gap-0.5">
        {SECTIONS.map((section) => <SectionBlock key={section} section={section} plugins={plugins} workspaces={workspaces} isActive={section === active} />)}
      </div>
      <div aria-hidden="true" className="flex-1" />
      <Legend />
    </nav>
  );
}
