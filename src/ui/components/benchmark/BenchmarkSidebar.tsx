import { CopyIcon, FilePlusIcon, PlusIcon, SparklesIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { Experiment } from '../../../types';
import { displayBinding } from '../../../shortcuts.js';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { DuplicateConfirm } from '@/components/benchmark/confirms';
import { DOT_CLASS, type ExperimentGroup, subLine } from '@/components/benchmark/sidebar-groups';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { t } from '@/i18n';
import { isSettingsClosed, onShortcutKey, type PanelId } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';

export interface BenchmarkSidebarProps { benchmark: Benchmark; workspaces: readonly string[]; isShown: boolean; activate(id: PanelId): void }

function SearchField({ value, onChange, inputRef }: { value: string; onChange(value: string): void; inputRef: RefObject<HTMLInputElement | null> }) {
  const keys = binding('benchmarkSearch');
  return (
    <div className="relative">
      <Input
        ref={inputRef} type="search" aria-label={t('benchmark.sidebar.search')} placeholder={t('benchmark.sidebar.search')} value={value}
        onChange={(event) => onChange(event.target.value)} className="h-8 pr-10 text-sm"
      />
      {keys && <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tracking-widest">{displayBinding(keys, isMac())}</kbd>}
    </div>
  );
}

// The screen's two-line menu item: the icon and label, then a hint under it
function MenuLabel({ icon, label, hint }: { icon: ReactNode; label: string; hint: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">{icon}{label}</span>
      <small className="text-muted-foreground text-xs">{hint}</small>
    </span>
  );
}

// A function, not a constant: the language is read when the menu renders, not when the module loads
const emptyLabel = (): ReactNode => <MenuLabel icon={<FilePlusIcon aria-hidden="true" className="size-4" />} label={t('benchmark.sidebar.empty')} hint={t('benchmark.sidebar.emptyHint')} />;

// experimento vazio: straight into the only workspace, a submenu of them when there are several (each with its colour)
function EmptyItem({ benchmark, workspaces }: { benchmark: Benchmark; workspaces: readonly string[] }) {
  const [only, ...others] = workspaces;
  if (only === undefined) return <DropdownMenuItem disabled>{emptyLabel()}</DropdownMenuItem>;
  if (others.length === 0) return <DropdownMenuItem onSelect={() => void benchmark.createEmpty(only)}>{emptyLabel()}</DropdownMenuItem>;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{emptyLabel()}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {workspaces.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => void benchmark.createEmpty(name)}><WorkspaceSquare name={name} />{name}</DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function NewMenu({ benchmark, workspaces, onDuplicate }: { benchmark: Benchmark; workspaces: readonly string[]; onDuplicate(experiment: Experiment): void }) {
  const live = benchmark.experiments.filter((e) => e.archived !== true);
  const { askAgent } = benchmark.slots;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('benchmark.sidebar.new')} title={t('benchmark.sidebar.new')}><PlusIcon aria-hidden="true" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        <EmptyItem benchmark={benchmark} workspaces={workspaces} />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={live.length === 0}>
            <MenuLabel icon={<CopyIcon aria-hidden="true" className="size-4" />} label={t('benchmark.sidebar.duplicate')} hint={t('benchmark.sidebar.duplicateHint')} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {live.map((e) => <DropdownMenuItem key={e.id} onSelect={() => onDuplicate(e)}>{e.name}</DropdownMenuItem>)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {askAgent && (
          <DropdownMenuItem onSelect={askAgent}>
            <MenuLabel icon={<SparklesIcon aria-hidden="true" className="size-4" />} label={t('benchmark.sidebar.ask')} hint={t('benchmark.sidebar.askHint')} />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Row({ experiment, isSelected, onSelect }: { experiment: Experiment; isSelected: boolean; onSelect(): void }) {
  return (
    <button
      type="button" aria-current={isSelected || undefined} onClick={onSelect}
      className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${isSelected ? 'bg-accent' : 'hover:bg-accent/60'}`}
    >
      <span className="flex items-center gap-2 text-[13px]">
        <span data-dot aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${DOT_CLASS[experiment.status]}`} />
        <span className="min-w-0 flex-1 truncate">{experiment.name}</span>
        <span className="text-muted-foreground text-xs">{experiment.arms.length}</span>
      </span>
      <small className="truncate pl-3.5 text-muted-foreground text-xs">{subLine(experiment)}</small>
    </button>
  );
}

function Group({ group, benchmark }: { group: ExperimentGroup; benchmark: Benchmark }) {
  return (
    <fieldset aria-label={t(`benchmark.sidebar.group.${group.id}`)} className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
      <h3 className="px-2 text-muted-foreground text-xs">{t(`benchmark.sidebar.group.${group.id}`)}</h3>
      {group.experiments.map((e) => <Row key={e.id} experiment={e} isSelected={e.id === benchmark.selected?.id} onSelect={() => benchmark.select(e.id)} />)}
    </fieldset>
  );
}

/** The benchmark view's left column (#461, benchmark.hv.html's #left-sidebar): the search, experimentos and its +, the live groups, the archived
 * group while expanded, and the arquivados · N footer. */
export function BenchmarkSidebar({ benchmark, workspaces, isShown, activate }: BenchmarkSidebarProps) {
  const search = useRef<HTMLInputElement>(null);
  const [duplicateOf, setDuplicateOf] = useState<Experiment>();
  // Mounted, collapsed, under the other views: its ⌘F acts only while the view is shown, opening a closed side first (as plugins')
  useEffect(() => (isShown ? onShortcutKey([[true, 'benchmarkSearch']], () => {
    activate('benchmark');
    search.current?.focus();
  }, isSettingsClosed) : undefined), [isShown, activate]);
  const { groups, archived, archivedCount } = benchmark.sidebar;
  const shown: ExperimentGroup[] = benchmark.isArchivedOpen && archived.length > 0 ? [...groups, { id: 'archived', experiments: archived }] : groups;
  return (
    <nav aria-label={t('benchmark.sidebar.title')} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3">
      <SearchField inputRef={search} value={benchmark.query} onChange={benchmark.setQuery} />
      <div className="flex items-center justify-between px-2 text-muted-foreground text-xs">
        {t('benchmark.sidebar.title')}
        <NewMenu benchmark={benchmark} workspaces={workspaces} onDuplicate={setDuplicateOf} />
      </div>
      {shown.map((group) => <Group key={group.id} group={group} benchmark={benchmark} />)}
      <div aria-hidden="true" className="flex-1" />
      {archivedCount > 0 && (
        <button type="button" aria-expanded={benchmark.isArchivedOpen} onClick={benchmark.toggleArchived} className="px-2 text-left text-muted-foreground text-xs hover:text-foreground">
          {t('benchmark.sidebar.archivedCount', { n: archivedCount })}
        </button>
      )}
      <DuplicateConfirm
        experiment={duplicateOf} open={duplicateOf !== undefined} onOpenChange={(open) => { if (!open) setDuplicateOf(undefined); }}
        onConfirm={() => benchmark.duplicate(duplicateOf?.id ?? '')}
      />
    </nav>
  );
}
