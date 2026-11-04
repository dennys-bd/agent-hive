import { HexagonIcon, type LucideIcon, MoreHorizontalIcon, SquareKanbanIcon } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { fixedShortcut } from '../../shortcut-registry';
import { displayBinding, fixedKeys } from '../../shortcuts';
import { HIVE_SOURCE, sourceOf } from '../../tasks';
import type { SourceConfig, Task, GithubAuth, ProjectSummary } from '../../types';
import { act } from '@/components/actions';
import { useIsFlowShown } from '@/components/MainDock';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';
import { isInDialog, isMac, isTextField, pressedFixed } from '@/lib/shortcut-bindings';

/** What the flow sidebar knows of the sources (redesign 09): the configured sources, the transport the project list is read with, and
 * Settings › Fluxo on one source, and on the list to add one (#500). */
export interface SourcesNav {
  sources: SourceConfig[]; auth: GithubAuth; onConfigure?(name: string): void; onAdd?(): void;
  hiveSource?: boolean; createIn?: string; // #846: absent (a test harness) = hive on, tasks created there
}

export interface FlowSourcesProps { nav: SourcesNav; tasks: Task[]; selected?: string; onPick(name: string): void; onList(): void; onOnly(name: string): void }

const ROW = 'flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/50 data-[selected]:bg-muted';
const ICON = 'size-4 shrink-0 text-muted-foreground';
const TYPE_ICON: Record<SourceConfig['type'], LucideIcon> = { github: SquareKanbanIcon }; // lucide has no GitHub brand icon (decision 12)

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

function SourceMenu({ source, nav, onOnly }: { source: SourceConfig; nav: SourcesNav; onOnly(name: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" className="-my-1 size-5 text-muted-foreground" aria-label={t('flow.source.menu', { name: source.name })}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {nav.onConfigure && <DropdownMenuItem onSelect={() => nav.onConfigure?.(source.name)}>{t('flow.source.configure')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => onOnly(source.name)}>{t('flow.source.only')}</DropdownMenuItem>
        {/* ponytail: /sources/refresh polls every source; a per-source route when one poll gets slow */}
        <DropdownMenuItem onSelect={() => void act('/sources/refresh')}>{t('flow.source.refresh')}</DropdownMenuItem>
        {source.type === 'github' && <DropdownMenuItem onSelect={() => openProject(source.owner, source.number, nav.auth)}>{t('flow.source.openGithub')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The pickSource key of a row (#500, #665): hive 1 while it is on (#846), then the configured sources by config order; none past the ninth
function keyOf(index: number): string | undefined {
  const key = fixedKeys(fixedShortcut('pickSource'), isMac())[index];
  return key === undefined ? undefined : displayBinding(key, isMac());
}
// Decision 12: name · owner · key in the tooltip; no visible key caps
const tipOf = (...parts: (string | undefined)[]): string => parts.filter((part) => part !== undefined).join(' · ');

const Count = ({ n }: { n: number }) => <span className="w-6 text-right text-muted-foreground text-xs tabular-nums">{n}</span>;
const MenuSlot = () => <span className="size-5 shrink-0" />; // the hive row keeps the ⋯ column, so the counts line up

// The row a digit from 1 names (#665, #846): with hive on, 1 is hive and n ≥ 2 the (n - 1)th source; with it off, n is the nth source
const rowOfDigit = (digit: number, sources: SourceConfig[], hasHive: boolean): string | undefined =>
  (hasHive ? (digit === 1 ? HIVE_SOURCE : sources[digit - 2]?.name) : sources[digit - 1]?.name);

// Alt+0 opens todas em lista (#572), Alt+1 hive while it is on (#846) and Alt+2–9 the configured sources (#585, #665), while the tasks view shows and no text field or dialog has the
// key. A digit with no row does nothing and lets the key go on
function useSourceKeys(sources: SourceConfig[], hasHive: boolean, onPick: (name: string) => void, onList: () => void): void {
  const isShown = useIsFlowShown();
  useEffect(() => {
    if (!isShown) return undefined;
    const listener = (event: KeyboardEvent): void => {
      const digit = isTextField(event.target) || isInDialog(event.target) ? -1 : pressedFixed(event, 'pickSource');
      if (digit < 0) return;
      const name = digit === 0 ? undefined : rowOfDigit(digit, sources, hasHive);
      if (digit > 0 && name === undefined) return;
      event.preventDefault();
      if (name === undefined) onList();
      else onPick(name);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [isShown, sources, hasHive, onPick, onList]);
}

// The Hive's own tasks (#665): a plain button, since there is nothing to configure, refresh or open, and one line (handoff §4c)
function HiveRow({ count, isSelected, onPick }: { count: number; isSelected: boolean; onPick(name: string): void }) {
  return (
    <button type="button" title={tipOf(HIVE_SOURCE, keyOf(1))} className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected} onClick={() => onPick(HIVE_SOURCE)}>
      <span className="flex items-center gap-2"><HexagonIcon aria-hidden="true" className={ICON} /><span className="min-w-0 flex-1 truncate">{HIVE_SOURCE}</span><Count n={count} /><MenuSlot /></span>
    </button>
  );
}

interface SourceRowProps { source: SourceConfig; index: number; count: number; nav: SourcesNav; isSelected: boolean; onPick(name: string): void; onOnly(name: string): void }

// A configured source's row (handoff §4c): its type icon, name, count and ⋯, then owner · type under the name. A div, not a button: the ⋯ is
// a button of its own inside the row. A click in its menu, portaled out yet bubbling through React, is not the row's either
function SourceRow({ source, index, count, nav, isSelected, onPick, onOnly }: SourceRowProps) {
  const Icon = TYPE_ICON[source.type];
  return (
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      role="button" tabIndex={0} title={tipOf(source.name, source.owner, keyOf(index))} className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected}
      onClick={(e) => { if (e.currentTarget.contains(e.target as Node) && !(e.target as Element).closest('button')) onPick(source.name); }}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(source.name); } }}
    >
      <span className="flex items-center gap-2">
        <Icon aria-hidden="true" className={ICON} />
        <span className="min-w-0 flex-1 truncate">{source.name}</span>
        <Count n={count} />
        <SourceMenu source={source} nav={nav} onOnly={onOnly} />
      </span>
      <span className="pl-6 text-muted-foreground text-xs">{`${source.owner} · ${t(`flow.source.type.${source.type}`)}`}</span>
    </div>
  );
}

/** The tasks sidebar's sources (#572, handoff §4c): hive first while it is on (#846), then one row per configured source in config order. A
 * row's click opens its table. Its header (title and +) is the section's. */
export function FlowSources({ nav, tasks, selected, onPick, onList, onOnly }: FlowSourcesProps) {
  const hasHive = nav.hiveSource !== false;
  useSourceKeys(nav.sources, hasHive, onPick, onList);
  const count = (name: string): number => tasks.filter((c) => sourceOf(c) === name).length; // a Hive task counts under hive (#665)
  return (
    <div className="flex flex-col gap-0.5">
      {hasHive && <HiveRow count={count(HIVE_SOURCE)} isSelected={selected === HIVE_SOURCE} onPick={onPick} />}
      {nav.sources.map((source, i) => (
        <SourceRow key={source.name} source={source} index={i + (hasHive ? 2 : 1)} count={count(source.name)} nav={nav} isSelected={selected === source.name} onPick={onPick} onOnly={onOnly} />
      ))}
    </div>
  );
}
