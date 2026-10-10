import { MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fixedShortcut } from '../../shortcut-registry';
import { displayBinding, fixedKeys } from '../../shortcuts';
import { HIVE_SOURCE, sourceOf } from '../../tasks';
import type { SourceConfig, Task, GithubAuth, ProjectSummary } from '../../types';
import { act } from '@/components/actions';
import { useIsFlowShown } from '@/components/MainDock';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';
import { isInDialog, isMac, isTextField, pressedFixed } from '@/lib/shortcut-bindings';

/** What the flow sidebar knows of the sources (redesign 09): the configured sources, the transport the project list is read with, and
 * Settings › Fluxo on one source, and on the list to add one (#500). */
export interface SourcesNav {
  sources: SourceConfig[]; auth: GithubAuth; onConfigure?(name: string): void; onAdd?(): void;
  hiveSource?: boolean; createIn?: string; // #846: absent (a test harness) = hive on, tasks created there
}

interface FlowSourcesProps { nav: SourcesNav; tasks: Task[]; selected?: string | null; onPick(name?: string): void } // null: a repository is picked (#757), so no row is

const ROW = 'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/50 data-[selected]:bg-muted';

// The config keeps only the owner and the number; whether the owner is a user or an org lives in the project's own url, which the settings
// list answers
function openProject(owner: string, number: number, auth: GithubAuth): void {
  getJson<ProjectSummary[]>(`/settings/projects?${new URLSearchParams({ owner, auth })}`)
    .then((projects) => {
      const url = projects.find((p) => p.number === number)?.url;
      if (url === undefined) toast.error(t('flow.source.notFound', { owner, number }));
      else window.open(url, '_blank', 'noreferrer');
    })
    .catch((err: Error) => toast.error(err.message));
}

function SourceMenu({ source, nav, onPick }: { source: SourceConfig; nav: SourcesNav; onPick(name: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" className="-my-1 size-5 text-muted-foreground" aria-label={t('flow.source.menu', { name: source.name })}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {nav.onConfigure && <DropdownMenuItem onSelect={() => nav.onConfigure?.(source.name)}>{t('flow.source.configure')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => onPick(source.name)}>{t('flow.source.only')}</DropdownMenuItem>
        {/* ponytail: /sources/refresh polls every source; a per-source route when one poll gets slow */}
        <DropdownMenuItem onSelect={() => void act('/sources/refresh')}>{t('flow.source.refresh')}</DropdownMenuItem>
        {source.type === 'github' && <DropdownMenuItem onSelect={() => openProject(source.owner, source.number, nav.auth)}>{t('flow.source.openGithub')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The pickSource key of the nth row (#500, #665): todas 0, hive 1 while it is on (#846), then the configured sources from 2 (from 1 with hive off) by the config's order, so a filtered
// list keeps each row on the key that picks it. None past the ninth, which no key reaches
function PickHint({ index }: { index: number }) {
  const key = fixedKeys(fixedShortcut('pickSource'), isMac())[index];
  return key === undefined ? null : (
    // aria-hidden on a wrapper: biome takes a bare kbd for focusable
    <span aria-hidden="true"><kbd data-key-hint="" className="rounded-[4px] border px-1.5 py-px font-sans tracking-widest">{displayBinding(key, isMac())}</kbd></span>
  );
}

// Fixed widths right of the key cap line the caps up in one column (#671); a row with no ⋯ keeps its slot empty
const Count = ({ n }: { n: number }) => <span className="w-6 text-right tabular-nums">{n}</span>;
const MenuSlot = () => <span data-menu-slot="" className="size-5 shrink-0" />;

// The row a digit from 1 names (#665, #846): with hive on, 1 is hive and n ≥ 2 the (n - 1)th source; with it off, n is the nth source
const rowOfDigit = (digit: number, sources: SourceConfig[], hasHive: boolean): string | undefined =>
  (hasHive ? (digit === 1 ? HIVE_SOURCE : sources[digit - 2]?.name) : sources[digit - 1]?.name);

// Alt+0 picks todas, Alt+1 hive while it is on (#846) and Alt+2–9 the configured sources (#585, #665), while the flow shows and no text field or dialog has the
// key. A digit with no row does nothing and lets the key go on
function useSourceKeys(sources: SourceConfig[], hasHive: boolean, onPick: (name?: string) => void): void {
  const isShown = useIsFlowShown();
  useEffect(() => {
    if (!isShown) return undefined;
    const listener = (event: KeyboardEvent): void => {
      const digit = isTextField(event.target) || isInDialog(event.target) ? -1 : pressedFixed(event, 'pickSource');
      if (digit < 0) return;
      const name = digit === 0 ? undefined : rowOfDigit(digit, sources, hasHive);
      if (digit > 0 && name === undefined) return;
      event.preventDefault();
      onPick(name);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [isShown, sources, hasHive, onPick]);
}

// The Hive's own tasks (#665), the ones with no source: a plain button like todas, since there is nothing to configure, refresh or open
function HiveRow({ count, isSelected, onPick }: { count: number; isSelected: boolean; onPick(name: string): void }) {
  return (
    <button type="button" className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected} onClick={() => onPick(HIVE_SOURCE)}>
      <span className="flex items-center justify-between gap-2">
        <span className="truncate">{HIVE_SOURCE}</span>
        <span className="flex items-center gap-2.5 text-muted-foreground text-xs"><PickHint index={1} /><Count n={count} /><MenuSlot /></span>
      </span>
      <span className="text-muted-foreground text-xs">{t('flow.source.type.hive')}</span>
    </button>
  );
}

interface SourceRowProps { source: SourceConfig; index: number; count: number; nav: SourcesNav; isSelected: boolean; onPick(name?: string): void }

// A configured source's row. A div, not a button: the ⋯ is a button of its own inside the row. A click in its menu, portaled out yet
// bubbling through React, is not the row's either
function SourceRow({ source, index, count, nav, isSelected, onPick }: SourceRowProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      role="button" tabIndex={0} className={`${ROW} cursor-pointer`} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected}
      onClick={(e) => { if (e.currentTarget.contains(e.target as Node) && !(e.target as Element).closest('button')) onPick(source.name); }}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(source.name); } }}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate">{source.name}</span>
        <span className="flex items-center gap-2.5 text-muted-foreground text-xs">
          <PickHint index={index} />
          <Count n={count} />
          <SourceMenu source={source} nav={nav} onPick={onPick} />
        </span>
      </span>
      <span className="text-muted-foreground text-xs">{t(`flow.source.type.${source.type}`)}</span>
    </div>
  );
}

/** The sources of the flow sidebar (redesign 09): todas first, then hive while it is on (the tasks created in the Hive, #665, #846), then one row per source with its task count and type. A row's click filters
 * the flow to it, a shortcut: the flow still aggregates every source. filtrar narrows the list by name. */
export function FlowSources({ nav, tasks, selected, onPick }: FlowSourcesProps) {
  const [query, setQuery] = useState<string>();
  const hasHive = nav.hiveSource !== false;
  useSourceKeys(nav.sources, hasHive, onPick);
  const term = (query ?? '').trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(term);
  const shown = nav.sources.filter((b) => matches(b.name));
  const count = (name: string): number => tasks.filter((c) => sourceOf(c) === name).length; // a Hive task counts under hive (#665)
  return (
    <div className="flex min-h-0 flex-col gap-0.5">
      <div className="flex items-center justify-between pb-1.5 text-muted-foreground text-xs">
        <span>{t('flow.sources')}</span>
        <span className="flex items-center gap-2">
          <button type="button" className="cursor-pointer hover:text-foreground" aria-pressed={query !== undefined} onClick={() => setQuery((q) => (q === undefined ? '' : undefined))}>
            {t('flow.sources.filter')}
          </button>
          {nav.onAdd && (
            <Button type="button" size="icon-xs" variant="ghost" className="-my-1 size-5 text-muted-foreground" aria-label={t('flow.sources.add')} onClick={nav.onAdd}>
              <PlusIcon />
            </Button>
          )}
        </span>
      </div>
      {query !== undefined && (
        <Input autoFocus className="mb-1 h-7 text-[13px]" placeholder={t('flow.sources.search')} aria-label={t('flow.sources.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        <button type="button" className={`${ROW} flex-row justify-between`} data-selected={selected === undefined ? '' : undefined} aria-pressed={selected === undefined} onClick={() => onPick(undefined)}>
          <span>{t('flow.sources.all')}</span>
          <span className="flex items-center gap-2.5 text-muted-foreground text-xs"><PickHint index={0} /><Count n={tasks.length} /><MenuSlot /></span>
        </button>
        {hasHive && matches(HIVE_SOURCE) && <HiveRow count={count(HIVE_SOURCE)} isSelected={selected === HIVE_SOURCE} onPick={onPick} />}
        {shown.map((source) => (
          <SourceRow
            key={source.name} source={source} index={nav.sources.indexOf(source) + (hasHive ? 2 : 1)} count={count(source.name)} nav={nav}
            isSelected={selected === source.name} onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}
