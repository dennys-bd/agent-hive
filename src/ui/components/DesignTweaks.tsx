import { XIcon } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { fitValue, TWEAK_TEXT_MAX, type TweakSchema } from '../../design-tweaks';
import type { DesignTweakValue } from '../../types';
import { TOGGLE_ITEM, TOGGLE_TRACK } from '@/components/DesignComments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TweakBlock } from '@/hooks/use-design-tweaks';
import { useTweakOverflow } from '@/hooks/use-tweak-overflow';
import { t } from '@/i18n';

// The design pane's tweaks (#241): the controls a screen's hv-tweaks block declares, a row under the bar and the floating panel more… opens
// (the user's mockups). Values come in settled (design-tweaks.ts) and leave only when they fit.

type Tweak = TweakSchema[number];
type EnumTweak = Extract<Tweak, { type: 'enum' }>;
type FieldTweak = Extract<Tweak, { type: 'text' | 'number' }>;
type Values = Readonly<Record<string, DesignTweakValue>>;
type OnChange = (name: string, value: DesignTweakValue) => void;
interface ControlProps { tweak: Tweak; value: DesignTweakValue; onChange: OnChange; isPanel?: boolean }

const SEGMENTED_MAX = 3; // the panel's enum of up to 3 options is a segmented control (mockup, image 2)
const FIELD = 'h-5 rounded-sm px-1.5 text-xs md:text-xs';

function EnumSelect({ tweak, value, onChange }: { tweak: EnumTweak; value: DesignTweakValue; onChange: OnChange }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(tweak.name, next)}>
      <SelectTrigger size="sm" aria-label={tweak.name} className={`${FIELD} gap-1 data-[size=sm]:h-5`}><SelectValue /></SelectTrigger>
      <SelectContent>{tweak.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function EnumSegments({ tweak, value, onChange }: { tweak: EnumTweak; value: DesignTweakValue; onChange: OnChange }) {
  return (
    <ToggleGroup type="single" size="xs" aria-label={tweak.name} value={String(value)} onValueChange={(next) => { if (next !== '') onChange(tweak.name, next); }} className={TOGGLE_TRACK}>
      {tweak.options.map((option) => <ToggleGroupItem key={option} value={option} className={TOGGLE_ITEM}>{option}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

// Text and number commit on blur and on Enter, and only a value that fits: a misfit (out of bounds, not a number) goes back to the last good one
function TweakInput({ tweak, value, onChange }: { tweak: FieldTweak; value: DesignTweakValue; onChange: OnChange }) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) { // a comment's state or a new block moved the value: the field follows it
    setShown(value);
    setDraft(String(value));
  }
  const isNumber = tweak.type === 'number';
  const commit = (): void => {
    const fitted = fitValue(tweak, isNumber ? (draft.trim() === '' ? Number.NaN : Number(draft)) : draft);
    if (fitted === undefined) setDraft(String(value));
    else if (fitted !== value) onChange(tweak.name, fitted);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  };
  const limits = tweak.type === 'number' ? { min: tweak.min, max: tweak.max, step: tweak.step } : { maxLength: TWEAK_TEXT_MAX };
  return (
    <Input
      aria-label={tweak.name} type={isNumber ? 'number' : 'text'} value={draft} {...limits} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      className={`${FIELD} ${isNumber ? 'w-16' : 'w-28'}`}
    />
  );
}

function TweakControl({ tweak, value, onChange, isPanel = false }: ControlProps) {
  if (tweak.type === 'enum') {
    return isPanel && tweak.options.length <= SEGMENTED_MAX ? <EnumSegments tweak={tweak} value={value} onChange={onChange} /> : <EnumSelect tweak={tweak} value={value} onChange={onChange} />;
  }
  if (tweak.type === 'boolean') return <Switch aria-label={tweak.name} checked={value === true} onCheckedChange={(on) => onChange(tweak.name, on)} />;
  return <TweakInput tweak={tweak} value={value} onChange={onChange} />;
}

const Labelled = (props: ControlProps) => (
  <span className={`flex shrink-0 items-center gap-1.5 ${props.isPanel ? 'justify-between' : ''}`}>
    <span aria-hidden="true">{props.tweak.name}</span>
    <TweakControl {...props} />
  </span>
);

// The panel's sections (#241): the ungrouped first, then each group in the order its first tweak was declared
function groupsOf(schema: TweakSchema): { name?: string; tweaks: Tweak[] }[] {
  const names = [...new Set(schema.flatMap((tweak) => (tweak.group === undefined ? [] : [tweak.group])))];
  const loose = schema.filter((tweak) => tweak.group === undefined);
  return [...(loose.length > 0 ? [{ tweaks: loose }] : []), ...names.map((name) => ({ name, tweaks: schema.filter((tweak) => tweak.group === name) }))];
}

interface Offset { x: number; y: number }

// The panel's header drags it (#342): the offset goes on CSS translate, apart from the transform Radix positions it with. The close button
// keeps its click.
function useDragOffset(): { offset: Offset; handle: { onPointerDown(e: PointerEvent<HTMLElement>): void; onPointerMove(e: PointerEvent<HTMLElement>): void; onPointerUp(): void } } {
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const start = useRef<{ x: number; y: number; from: Offset } | null>(null);
  return {
    offset,
    handle: {
      onPointerDown: (event) => {
        if (event.button !== 0 || (event.target as Element).closest('button') !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, y: event.clientY, from: offset };
      },
      onPointerMove: (event) => {
        const drag = start.current;
        if (drag !== null) setOffset({ x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y });
      },
      onPointerUp: () => { start.current = null; },
    },
  };
}

interface PanelProps { schema: TweakSchema; values: Values; onChange: OnChange; isOpen: boolean; setOpen(open: boolean): void }

// The offset outlives a close: the panel stays mounted while more… shows, so it opens again where it was dragged to, never persisted
function TweaksPanel({ schema, values, onChange, isOpen, setOpen }: PanelProps) {
  const { offset, handle } = useDragOffset();
  const title = t('design.tweaks');
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" size="xs" variant="ghost" data-tweak-more className="absolute right-0 shrink-0 bg-background text-muted-foreground">{t('design.tweaks.more')}</Button></PopoverTrigger>
      <PopoverContent aria-label={title} align="end" style={{ translate: `${offset.x}px ${offset.y}px` }} className="w-72 p-0 text-xs">
        <div {...handle} className="flex h-[30px] cursor-move touch-none select-none items-center border-b px-2.5">
          <h2 className="font-medium">{title}</h2>
          <Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={t('design.tweaks.close')} title={t('design.tweaks.close')} onClick={() => setOpen(false)}><XIcon /></Button>
        </div>
        {groupsOf(schema).map((group) => (
          <section key={group.name === undefined ? '' : `g:${group.name}`} className="flex flex-col gap-2 border-b p-2.5 text-muted-foreground last:border-b-0">
            {group.name !== undefined && <h3 className="font-medium text-foreground">{group.name}</h3>}
            {group.tweaks.map((tweak) => <Labelled key={tweak.name} tweak={tweak} value={values[tweak.name] ?? tweak.default} onChange={onChange} isPanel />)}
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// A control past the row's end stays in its layout, so the others never move as it leaves, but no one sees or reaches it (#342)
const HIDDEN = { 'aria-hidden': true, inert: true, className: 'invisible flex shrink-0' } as const;

function TweakRow({ schema, values, onChange }: { schema: TweakSchema; values: Values; onChange: OnChange }) {
  const row = useRef<HTMLDivElement>(null);
  const [isOpen, setOpen] = useState(false);
  const fits = useTweakOverflow(row, schema.map((tweak) => tweak.name));
  return (
    <div ref={row} className="relative flex min-w-0 flex-1 items-center gap-3 self-stretch overflow-hidden">
      {schema.map((tweak, index) => (
        <span key={tweak.name} data-tweak-item {...(isOpen || index >= fits ? HIDDEN : { className: 'flex shrink-0' })}>
          <Labelled tweak={tweak} value={values[tweak.name] ?? tweak.default} onChange={onChange} />
        </span>
      ))}
      {fits < schema.length && <TweaksPanel schema={schema} values={values} onChange={onChange} isOpen={isOpen} setOpen={setOpen} />}
    </div>
  );
}

export interface DesignTweaksProps { block: Exclude<TweakBlock, { status: 'none' }>; values: Values; onChange: OnChange }

/** The tweaks row (#241): under the bar while the file has a block, valid or not. Invalid: its words, no control and no toast (m-11). */
export function DesignTweaks({ block, values, onChange }: DesignTweaksProps) {
  return (
    <div role="toolbar" aria-label={t('design.tweaks')} className="flex h-[30px] shrink-0 items-center border-b px-2.5 text-muted-foreground text-xs">
      {block.status === 'invalid'
        ? <span className="text-destructive">{t('design.tweaks.invalid')}</span>
        : <TweakRow schema={block.schema} values={values} onChange={onChange} />}
    </div>
  );
}
