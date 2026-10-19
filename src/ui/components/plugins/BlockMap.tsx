import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LintAnnotation } from '../../../template-lint';
import type { MapBlock, Reference, TemplateMap } from '../../../template-map';
import type { ChainBlock } from '../../../template-preview';
import { type MapDrag, useMapDrag } from '@/components/plugins/map-drag';
import { t } from '@/i18n';
import { branchLabel } from '@/lib/template-view';

export interface BlockMapProps {
  map: TemplateMap; collapsed: readonly number[]; dimmed: ReadonlySet<number>; canDrag: boolean;
  onReveal(line: number): void; onToggle(line: number): void; onMove(line: number, index: number): void;
  dots?: ReadonlyMap<number, readonly LintAnnotation[]>; onDot?(annotation: LintAnnotation): void; // #327: each row's annotations, by its line
}
type Heading = Extract<MapBlock, { kind: 'heading' }>;
interface Ctx extends Pick<BlockMapProps, 'collapsed' | 'dimmed' | 'canDrag' | 'onReveal' | 'onToggle' | 'dots' | 'onDot'> { drag: MapDrag }
interface Handle { parent: string; index: number }

function Chips({ references }: { references: readonly Reference[] }) {
  if (references.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1 pl-1.5">
      {references.map((ref) => <span key={`${ref.kind}:${ref.name}`} className="rounded border px-1 font-mono text-[10px] text-muted-foreground">{ref.name}</span>)}
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
      className={`size-2 shrink-0 rounded-full ${isRed ? 'bg-destructive' : 'bg-waiting'}`}
    />
  );
}

function Row({ title, line, references, ctx, handle, isMono = false, children }: { title: string; line: number; references: readonly Reference[]; ctx: Ctx; handle?: Handle; isMono?: boolean; children?: ReactNode }) {
  return (
    <div className={`flex flex-col gap-0.5 ${ctx.dimmed.has(line) ? 'opacity-35' : ''}`}>
      <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent">
        <button type="button" onClick={() => ctx.onReveal(line)} className={`min-w-0 flex-1 truncate text-left ${isMono ? 'font-mono text-[11px]' : ''}`}>{title}</button>
        <Dot line={line} ctx={ctx} />
        {children}
        <span className="font-mono text-[11px] text-muted-foreground">{line}</span>
        {handle && ctx.canDrag && (
          <span title={t('plugins.map.drag')} className="cursor-grab text-muted-foreground" {...ctx.drag.handleProps(line, handle.parent)}><GripVerticalIcon className="size-3" /></span>
        )}
      </div>
      <Chips references={references} />
    </div>
  );
}

function HeadingBlock({ heading, handle, ctx }: { heading: Heading; handle: Handle; ctx: Ctx }) {
  const isCollapsed = ctx.collapsed.includes(heading.line);
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div className={heading.level === 3 ? 'ml-[14px] border-l pl-2' : 'font-medium'}>
      <Row title={heading.title} line={heading.line} references={heading.references} ctx={ctx} handle={handle}>
        {heading.level === 2 && heading.count > 0 && (
          <button type="button" aria-expanded={!isCollapsed} onClick={() => ctx.onToggle(heading.line)} className="flex items-center gap-0.5 font-normal text-[11px] text-muted-foreground">
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
    <div className="ml-[14px] flex flex-col border-l border-dashed pl-2">
      {chain.branches.map((branch, index) => (
        <div key={branch.line}>
          <Row title={branchLabel(branch)} line={branch.line} references={branch.references} ctx={ctx} handle={index === 0 ? handle : undefined} isMono />
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
    <ul className="flex flex-col gap-0.5">
      {blocks.map((block) => {
        const index = movable.indexOf(block);
        return (
          <li key={`${block.kind}:${block.line}`} {...(index < 0 ? {} : ctx.drag.dropProps(block.line, parent, index))}>
            <Block block={block} handle={{ parent, index }} ctx={ctx} />
          </li>
        );
      })}
    </ul>
  );
}

/** The map column (#319, handoff 11b): the template's blocks from buildMap, a click to the line, drag among siblings, a `##` that collapses,
 * and the preview's dimming. */
export function BlockMap({ map, onMove, ...ctx }: BlockMapProps) {
  const drag = useMapDrag(onMove);
  return (
    <nav aria-label={t('plugins.map.label')} className="w-[236px] shrink-0 overflow-y-auto border-r p-2 text-xs">
      <Blocks blocks={map.blocks} parent="root" ctx={{ ...ctx, drag }} />
    </nav>
  );
}
