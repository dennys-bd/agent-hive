import { useEffect, useId, useRef } from 'react';
import type { Arm, Experiment } from '../../../../types';
import { editArm } from '@/components/benchmark/arms/arm-api';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { type CompareCell, type CompareRow, compareRows, copiedOverrides, hiddenCount, holdsSame, isEqualRow, isSetupRowId, type SetupRowId } from '@/components/benchmark/compare/rows';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { t, tPlural } from '@/i18n';

export interface CompareTabProps { experiment: Experiment; benchmark: Benchmark }

const CELL = 'px-3.5 py-2 text-left font-mono text-xs [overflow-wrap:anywhere]';
const armTitle = (arm: Arm): string => `${arm.letter} · ${arm.name}`;
// The screen's .cmp grid: the label column, then the base and one column per arm sharing the rest
const columnsOf = (experiment: Experiment): string => `160px repeat(${experiment.arms.length + 1}, minmax(0, 1fr))`;

// The active tab's underline (BenchmarkView): the highlight is no status, so no colour, and not --accent, which marks an override
const UNDERLINE = 'shadow-[inset_0_-2px_0_var(--foreground)]';

function HeadRow({ experiment, highlightedArm }: { experiment: Experiment; highlightedArm?: string }) {
  return (
    <thead className="block">
      <tr className="grid rounded-t-lg border-b bg-card" style={{ gridTemplateColumns: columnsOf(experiment) }}>
        <th className="px-3.5 py-2.5 text-left font-normal text-muted-foreground text-xs">{t('benchmark.compare.config')}</th>
        <th className="px-3.5 py-2.5 text-left text-muted-foreground">{t('benchmark.compare.base')}</th>
        {experiment.arms.map((arm) => {
          const isHighlighted = arm.id === highlightedArm;
          return (
            <th key={arm.id} data-arm={arm.id} aria-current={isHighlighted || undefined} className={`px-3.5 py-2.5 text-left ${isHighlighted ? UNDERLINE : ''}`}>
              {armTitle(arm)}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

interface CopyMenuProps { experiment: Experiment; rowId: SetupRowId; from: Arm; value: string }

// copiar para (the user, round 1): every other arm, one already holding the value disabled. A pick posts that arm's whole overrides; the table
// changes only when the stream brings the new state, and a refusal is send's toast
function CopyMenu({ experiment, rowId, from, value }: CopyMenuProps) {
  const targets = experiment.arms.filter((arm) => arm.id !== from.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`${CELL} w-full bg-accent text-foreground hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-empty`}>{value}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('benchmark.compare.copyTo')}</DropdownMenuLabel>
        {targets.map((to) => (
          <DropdownMenuItem
            key={to.id} disabled={holdsSame(experiment, rowId, from, to)}
            onSelect={() => void editArm(experiment.id, to.id, { overrides: copiedOverrides(experiment, rowId, from, to) })}
          >
            {armTitle(to)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CellProps { experiment: Experiment; row: CompareRow; cell: CompareCell }

// · when the arm equals the base; its value on --accent when it overrides it, a button only where a copy may post (not isolation, not locked)
function Cell({ experiment, row, cell }: CellProps) {
  if (cell.isSame) return <td className={`${CELL} text-muted-foreground/60`}>·</td>;
  const from = experiment.arms.find((arm) => arm.id === cell.armId);
  // A lone arm has nowhere to copy to, so its cell is no button with an empty menu
  if (!cell.isCopyable || !isSetupRowId(row.id) || from === undefined || experiment.arms.length < 2) return <td className={`${CELL} bg-accent text-foreground`}>{cell.value}</td>;
  return <td className="flex"><CopyMenu experiment={experiment} rowId={row.id} from={from} value={cell.value} /></td>;
}

function Row({ experiment, row }: { experiment: Experiment; row: CompareRow }) {
  return (
    <tr className="grid border-b last:border-b-0" style={{ gridTemplateColumns: columnsOf(experiment) }}>
      <th scope="row" className={`${CELL} font-normal font-sans text-muted-foreground`}>{row.label}</th>
      <td className={`${CELL} text-muted-foreground`}>{row.base}</td>
      {row.cells.map((cell) => <Cell key={cell.armId} experiment={experiment} row={row} cell={cell} />)}
    </tr>
  );
}

/** The comparar tab (#464, benchmark.hv.html's #s-comparar): every arm against the base, row by row. só diferenças hides the rows where every
 *  arm equals the base and counts them in the foot note; the switch lives in the dock, so it survives a change of tab or view. */
export function CompareTab({ experiment, benchmark }: CompareTabProps) {
  const switchId = useId();
  const tableRef = useRef<HTMLTableElement>(null);
  const { highlightedArm } = benchmark;
  // ver em comparar may land on a column off screen while many arms are compared; the lookup avoids CSS.escape, which jsdom lacks
  useEffect(() => {
    if (highlightedArm === undefined) return;
    const heads = Array.from(tableRef.current?.querySelectorAll<HTMLElement>('[data-arm]') ?? []);
    heads.find((head) => head.dataset.arm === highlightedArm)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [highlightedArm]);
  const rows = compareRows(experiment);
  const shown = benchmark.isDiffOnly ? rows.filter((row) => !isEqualRow(row)) : rows;
  const hidden = hiddenCount(rows);
  const legend = t('benchmark.compare.legend');
  return (
    <section aria-label={t('benchmark.header.tab.compare')} className="flex flex-col gap-3 p-6">
      <div className="flex items-center gap-3 text-[13px]">
        <span className="text-muted-foreground">{t('benchmark.compare.lead')}</span>
        <span aria-hidden="true" className="flex-1" />
        <Label htmlFor={switchId}>{t('benchmark.compare.diffOnly')}</Label>
        <Switch id={switchId} checked={benchmark.isDiffOnly} onCheckedChange={benchmark.toggleDiffOnly} />
      </div>
      <table ref={tableRef} aria-label={t('benchmark.header.tab.compare')} className="flex flex-col overflow-x-auto rounded-lg border text-[13px]">
        <HeadRow experiment={experiment} highlightedArm={highlightedArm} />
        <tbody className="block">{shown.map((row) => <Row key={row.id} experiment={experiment} row={row} />)}</tbody>
      </table>
      <p className="text-muted-foreground text-xs">{benchmark.isDiffOnly ? `${tPlural('benchmark.compare.hidden', hidden, { n: hidden })} · ${legend}` : legend}</p>
    </section>
  );
}
