import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon, PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EditorAnnotation } from '@/hooks/use-annotations';
import type { MapBlock, Reference, TemplateMap } from '../../../template-map';
import type { ChainBlock } from '../../../template-preview';
import { type MapDrag, useMapDrag } from '@/components/plugins/map-drag';
import { t } from '@/i18n';
import { branchSentence } from '@/lib/template-view';

export interface MapGap { line: number; card: ReactNode } // the open "+"'s card, in the map's flow where its "+" was (#322)
export interface BlockMapProps {
  map: TemplateMap; collapsed: readonly number[]; dimmed: ReadonlySet<number>; canDrag: boolean;
  onReveal(line: number): void; onToggle(line: number): void; onMove(line: number, index: number): void;
  dots?: ReadonlyMap<number, readonly EditorAnnotation[]>; onDot?(annotation: EditorAnnotation): void; // #327: each row's annotations, by its line
  onJump(line: number): void; // #982: a chip's click, with the line of its call
  appendLine: number; onPlus?(line: number): void; gap?: MapGap; // #322: the trailing "+"'s line; no onPlus, no "+" (the preview)
  current?: number; // #492: the line of the row the caret is in, raised
}
type Heading = Extract<MapBlock, { kind: 'heading' }>;
interface Ctx extends Pick<BlockMapProps, 'collapsed' | 'dimmed' | 'canDrag' | 'onReveal' | 'onJump' | 'onToggle' | 'dots' | 'onDot' | 'onPlus' | 'gap' | 'current'> { drag: MapDrag }
interface Handle { parent: string; index: number }

// #982: a chip goes to the line that calls its item (the section's first call: buildMap keeps one Reference per kind and name), selecting nothing
function Chips({ references, ctx }: { references: readonly Reference[]; ctx: Ctx }) {
  if (references.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1 pt-1">
      {references.map((ref) => (
        <button
          key={`${ref.kind}:${ref.name}`} type="button" title={t('plugins.map.jump', { name: ref.name })} onClick={() => ctx.onJump(ref.line)}
          className="rounded-[3px] border px-[5px] font-mono text-soft text-xs leading-4 hover:bg-accent"
        >
          {ref.name}
        </button>
      ))}
    </span>
  );
}

// #327: one dot per row, red when any of its annotations is (status colours only); a click opens the first
function Dot({ line, ctx }: { line: number; ctx: Ctx }) {
  const list = ctx.dots?.get(line);
  if (list === undefined || list.length === 0) return null;
  const isRed = list.some((a) => a.severity === 'red');
  return (
    <button
      type="button" aria-label={t('plugins.annotations.dot')} data-severity={isRed ? 'red' : 'yellow'} onClick={() => ctx.onDot?.(list[0])}
      className={`size-1.5 shrink-0 rounded-full ${isRed ? 'bg-destructive' : 'bg-waiting'}`}
    />
  );
}

// The handoff's card kinds (#492): a block, a sub-block indented, a conditional block dashed and indented
type RowLook = 'block' | 'sub' | 'branch';
const LOOK: Record<RowLook, string> = { block: 'p-2', sub: 'ml-[14px] px-2 py-1.5', branch: 'ml-[14px] border-dashed p-2' };
interface RowProps { title: string; line: number; references: readonly Reference[]; ctx: Ctx; look?: RowLook; handle?: Handle; sentence?: string; children?: ReactNode }

function Row({ title, line, references, ctx, look = 'block', handle, sentence, children }: RowProps) {
  const isCurrent = ctx.current === line;
  return (
    <div
      data-line={line} data-current={isCurrent || undefined}
      className={`flex flex-col rounded-[6px] border ${LOOK[look]} ${isCurrent ? 'border-empty bg-card' : ''} ${ctx.dimmed.has(line) ? 'opacity-35' : ''}`}
    >
      <div className="flex min-h-[18px] items-center gap-1.5">
        {handle && ctx.canDrag && (
          <span title={t('plugins.map.drag')} className="cursor-grab text-faint" {...ctx.drag.handleProps(line, handle.parent)}><GripVerticalIcon className="size-2.5" /></span>
        )}
        <button type="button" onClick={() => ctx.onReveal(line)} className={`min-w-0 flex-1 truncate text-left ${look === 'sub' ? '' : 'font-medium'}`}>{title}</button>
        {children}
        <Dot line={line} ctx={ctx} />
        <span className="text-muted-foreground">{line}</span>
      </div>
      {sentence !== undefined && <span className="break-words text-muted-foreground leading-[18px]">{sentence}</span>}
      <Chips references={references} ctx={ctx} />
    </div>
  );
}

// Decision 10: a chain inserted at the line of the block after the "+"; decision 11: its card takes the "+"'s place while open. #5b6472 has no
// token of its own, so the "+" is faint, lit on hover (#492)
function Plus({ line, ctx }: { line: number; ctx: Ctx }) {
  if (ctx.gap?.line === line) return <>{ctx.gap.card}</>;
  const { onPlus } = ctx;
  if (onPlus === undefined) return null;
  return (
    <button type="button" aria-label={t('plugins.chain.add')} title={t('plugins.chain.add')} onClick={() => onPlus(line)} className="flex h-[26px] w-full items-center gap-2 text-faint hover:text-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex size-5 items-center justify-center rounded-full border border-current"><PlusIcon className="size-2.5" /></span>
      <span className="h-px flex-1 bg-border" />
    </button>
  );
}

function HeadingBlock({ heading, handle, ctx }: { heading: Heading; handle: Handle; ctx: Ctx }) {
  const isCollapsed = ctx.collapsed.includes(heading.line);
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div>
      <Row title={heading.title} line={heading.line} references={heading.references} ctx={ctx} handle={handle} look={heading.level === 3 ? 'sub' : 'block'}>
        {heading.level === 2 && heading.count > 0 && (
          <button type="button" aria-expanded={!isCollapsed} onClick={() => ctx.onToggle(heading.line)} className="flex items-center gap-0.5 text-muted-foreground">
            {t('plugins.map.subsections', { count: heading.count })}<Chevron className="size-3" />
          </button>
        )}
      </Row>
      {!isCollapsed && heading.children.length > 0 && <Blocks blocks={heading.children} parent={`h${heading.line}`} ctx={ctx} />}
    </div>
  );
}

// A chain moves whole (moveBlock moves it by its first line): its handle is on the if row; its branches only reveal
function ChainBlockRows({ chain, handle, ctx }: { chain: ChainBlock; handle: Handle; ctx: Ctx }) {
  return (
    <div className="flex flex-col">
      {chain.branches.map((branch, index) => (
        <div key={branch.line}>
          {index > 0 && <Plus line={branch.line} ctx={ctx} />}
          <Row
            title={t('plugins.chain.popover')} sentence={branchSentence(branch)} line={branch.line} references={branch.references} ctx={ctx}
            look="branch" handle={index === 0 ? handle : undefined}
          />
          {branch.children.length > 0 && <Blocks blocks={branch.children} parent={`b${branch.line}`} ctx={ctx} />}
        </div>
      ))}
    </div>
  );
}

function Block({ block, handle, ctx }: { block: MapBlock; handle: Handle; ctx: Ctx }) {
  if (block.kind === 'introduction') return <Row title={t('plugins.map.introduction')} line={block.line} references={block.references} ctx={ctx} />;
  if (block.kind === 'chain') return <ChainBlockRows chain={block} handle={handle} ctx={ctx} />;
  return <HeadingBlock heading={block} handle={handle} ctx={ctx} />;
}

// One parent's blocks: each movable one's row takes its siblings' drops at its index among them (the introduction never moves)
function Blocks({ blocks, parent, ctx }: { blocks: readonly MapBlock[]; parent: string; ctx: Ctx }) {
  const movable: readonly MapBlock[] = blocks.filter((block) => block.kind !== 'introduction');
  return (
    <ul className="flex flex-col">
      {blocks.map((block) => {
        const index = movable.indexOf(block);
        return (
          <li key={`${block.kind}:${block.line}`} {...(index < 0 ? {} : ctx.drag.dropProps(block.line, parent, index))}>
            <Plus line={block.line} ctx={ctx} />
            <Block block={block} handle={{ parent, index }} ctx={ctx} />
          </li>
        );
      })}
    </ul>
  );
}

/** The map column (#319, handoff 11b): the template's blocks from buildMap as cards (#492), a click to the line, drag among siblings, a `##`
 * that collapses, the caret's block raised, and the preview's dimming. */
export function BlockMap({ map, onMove, appendLine, ...rest }: BlockMapProps) {
  const drag = useMapDrag(onMove);
  const ctx: Ctx = { ...rest, drag };
  return (
    <nav aria-label={t('plugins.map.label')} className="w-[236px] shrink-0 overflow-y-auto border-r p-3 text-xs">
      <h3 className="pb-1.5 font-normal text-muted-foreground">{t('plugins.map.header')}</h3>
      <Blocks blocks={map.blocks} parent="root" ctx={ctx} />
      <Plus line={appendLine} ctx={ctx} />
    </nav>
  );
}
