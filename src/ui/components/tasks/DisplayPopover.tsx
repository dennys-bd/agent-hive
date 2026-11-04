import { SlidersHorizontalIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { HIVE_SOURCE, sourceOf } from '../../../tasks.js';
import type { Task } from '../../../types.js';
import type { SourcesNav } from '@/components/FlowSources';
import { SEGMENT } from '@/components/StartFields';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { type MessageKey, t } from '@/i18n';
import { type DisplayOptions, HIDDEN_EPICS, LOOP_LABELS, LOOPS } from '@/lib/flow-view';

type Patch = (patch: Partial<DisplayOptions>) => void;

/** A row of the sources section (#574): the name, the owner · type (none for hive) and the count of the view's tasks. */
export interface DisplaySource { name: string; detail?: string; count: number }

/** The rows (#574 decision 8, 9): hive first while it is on (as the sidebar lists it, #846), then the configured sources in config order, each counting the view's tasks before sourcesOff and before the search. */
export function displaySources(nav: SourcesNav | undefined, tasks: Task[]): DisplaySource[] {
  const count = (name: string): number => tasks.filter((c) => sourceOf(c) === name).length;
  const hive = nav?.hiveSource === false ? [] : [{ name: HIVE_SOURCE, count: count(HIVE_SOURCE) }];
  return [...hive, ...(nav?.sources ?? []).map((s) => ({ name: s.name, detail: `${s.owner} · ${t(`tasks.header.source.${s.type}` as MessageKey)}`, count: count(s.name) }))];
}

/** The header's legend (decision 10): todas as sources, the checked names in the popover's order, or nenhuma source; a stale name is ignored. */
export function sourcesLegend(sources: DisplaySource[], sourcesOff: string[]): string {
  const on = sources.filter((s) => !sourcesOff.includes(s.name));
  if (on.length === sources.length) return t('tasks.display.allSources');
  return on.length === 0 ? t('tasks.display.noSource') : on.map((s) => s.name).join(' · ');
}

interface SegmentedProps<T extends string> { label: string; values: readonly T[]; value: T; labelOf(value: T): string; onChange(value: T): void }

function Segmented<T extends string>({ label, values, value, labelOf, onChange }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single" aria-label={label} value={value} className="w-full gap-0.5 bg-muted p-0.5"
      // an empty v is a click on the chosen segment: nothing changes
      onValueChange={(v) => { const picked = values.find((x) => x === v); if (picked) onChange(picked); }}
    >
      {values.map((v) => <ToggleGroupItem key={v} value={v} className={SEGMENT}>{labelOf(v)}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

function Row({ label, hint, isDimmed = false, children }: { label: string; hint: string; isDimmed?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${isDimmed ? 'opacity-50' : ''}`}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
      <p className="text-[11px] leading-[15px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function SourcesSection({ sources, sourcesOff, onChange }: { sources: DisplaySource[]; sourcesOff: string[]; onChange: Patch }) {
  const flip = (name: string): void => onChange({ sourcesOff: sourcesOff.includes(name) ? sourcesOff.filter((n) => n !== name) : [...sourcesOff, name] }); // stale names stay
  const isAnyOff = sources.some((s) => sourcesOff.includes(s.name));
  return (
    <div className="border-b p-2">
      <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-muted-foreground">
        <span>{t('tasks.display.sources')}</span>
        {isAnyOff && <button type="button" className="hover:text-foreground" onClick={() => onChange({ sourcesOff: [] })}>{t('tasks.display.all')}</button>}
      </div>
      {sources.map((s) => (
        <label key={s.name} className="flex items-center gap-2 rounded-[4px] px-1 py-[5px] hover:bg-accent">
          <input type="checkbox" aria-label={s.name} checked={!sourcesOff.includes(s.name)} onChange={() => flip(s.name)} className="size-3.5 accent-foreground" />
          <span className="flex-1 truncate">{s.name}</span>
          {s.detail && <span className="text-xs text-muted-foreground">{s.detail}</span>}
          <span className="w-[22px] text-right tabular-nums text-muted-foreground">{s.count}</span>
        </label>
      ))}
    </div>
  );
}

function LoopsSection({ options, onChange }: { options: DisplayOptions; onChange: Patch }) {
  return (
    <div className="flex flex-col gap-2.5 border-b px-3 py-2.5">
      <Row label={t('tasks.display.loops')} hint={t(`tasks.display.loops.hint.${options.loops}` as MessageKey)}>
        <Segmented label={t('tasks.display.loops')} values={LOOPS} value={options.loops} labelOf={(v) => t(`tasks.display.loops.${v}` as MessageKey)} onChange={(loops) => onChange({ loops })} />
      </Row>
      <Row label={t('tasks.display.labels')} hint={t('tasks.display.labels.hint')} isDimmed={options.loops === 'none'}>
        <Segmented label={t('tasks.display.labels')} values={LOOP_LABELS} value={options.labels} labelOf={(v) => t(`tasks.display.labels.${v}` as MessageKey)} onChange={(labels) => onChange({ labels })} />
      </Row>
    </div>
  );
}

function TreeSection({ options, isTree, onChange }: { options: DisplayOptions; isTree: boolean; onChange: Patch }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="flex-1 font-normal">{t('tasks.display.tree')}</Label>
        <Switch id={id} checked={isTree} onCheckedChange={(tree) => onChange({ tree })} />
      </div>
      <Row label={t('tasks.display.epics')} hint={t(`tasks.display.epics.hint.${options.epics}` as MessageKey)}>
        <Segmented label={t('tasks.display.epics')} values={HIDDEN_EPICS} value={options.epics} labelOf={(v) => t(`tasks.display.epics.${v}` as MessageKey)} onChange={(epics) => onChange({ epics })} />
      </Row>
    </div>
  );
}

interface DisplayPopoverProps { options: DisplayOptions; onChange: Patch; sources: DisplaySource[]; isTree: boolean; hasLoops: boolean }

/** exibir (#574, handoff §3): the button and its 300px popover; `hasLoops` false (the list, the grid) drops the voltas and rótulos rows. */
export function DisplayPopover({ options, onChange, sources, isTree, hasLoops }: DisplayPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" title={t('tasks.display.title')} className="data-[state=open]:bg-accent">
          <SlidersHorizontalIcon aria-hidden="true" />{t('tasks.display')}<span aria-hidden="true" className="text-muted-foreground">⌄</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[300px] flex-col p-0 text-[13px]">
        <SourcesSection sources={sources} sourcesOff={options.sourcesOff} onChange={onChange} />
        {hasLoops && <LoopsSection options={options} onChange={onChange} />}
        <TreeSection options={options} isTree={isTree} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

export interface DisplayPropsInput { display: DisplayControls; sources?: SourcesNav; tasks: Task[]; isTree: boolean; hasLoops: boolean }

/** What a task view hands FlowHeader (#574): the legend and exibir, over the tasks the view shows. */
export function displayProps({ display, sources, tasks, isTree, hasLoops }: DisplayPropsInput): { legend: string; display: ReactNode } {
  const rows = displaySources(sources, tasks);
  return {
    legend: sourcesLegend(rows, display.options.sourcesOff),
    display: <DisplayPopover options={display.options} onChange={display.set} sources={rows} isTree={isTree} hasLoops={hasLoops} />,
  };
}
