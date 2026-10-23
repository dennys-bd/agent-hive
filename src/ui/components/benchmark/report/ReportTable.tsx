import { MoonIcon } from 'lucide-react';
import type { CSSProperties, HTMLAttributes } from 'react';
import type { ArmColumn, BenchReport } from '../../../../benchmark/report.js';
import { type CellText, diffText, ratioText, spreadText } from '@/components/benchmark/report/report-format';
import { type MessageKey, t, tPlural } from '@/i18n';

// One place for the table roles: the rows are grids, which a <table> cannot hold, and the role keeps the table for a screen reader (#467, as SessionsTable #778)
function Part({ role, ...props }: HTMLAttributes<HTMLDivElement> & { role: 'table' | 'row' | 'rowheader' | 'columnheader' | 'cell' }) {
  return <div role={role} {...props} />;
}

type RowText = (armId: string) => CellText;
interface Row { label: string; text: RowText }
interface SectionProps { title: string; rows: Row[]; arms: ArmColumn[]; style: CSSProperties }

// benchmark.hv.html's .rel grid, generalised past its four arms: the label column, then one per arm; wider than the tab, it scrolls inside it
const gridOf = (arms: number): CSSProperties => ({ gridTemplateColumns: `180px repeat(${arms}, minmax(120px, 1fr))` });
const ROW = 'grid items-baseline border-b last:border-b-0';
const PAD = 'px-3.5 py-[7px]';

function executionRows({ execution }: BenchReport): Row[] {
  const { tokens, cost, time, waiting, restarts, diff, tests } = execution;
  const row = (label: MessageKey, text: RowText): Row => ({ label: t(label), text });
  return [
    row('benchmark.report.row.tokens', (id) => spreadText('tokens', tokens.cells[id])),
    row('benchmark.report.row.cost', (id) => spreadText('cost', cost.cells[id])),
    row('benchmark.report.row.time', (id) => spreadText('time', time.cells[id])),
    row('benchmark.report.row.waiting', (id) => spreadText('time', waiting.cells[id])),
    row('benchmark.report.row.restarts', (id) => spreadText('score', restarts.cells[id])),
    row('benchmark.report.row.diff', (id) => diffText(diff.cells[id])),
    row('benchmark.report.row.tests', (id) => ratioText(tests.cells[id])),
  ];
}

// One row labelled by the first and last scenario, left out when no arm walked any
function clickRows({ clicks }: BenchReport): Row[] {
  if (!Object.values(clicks.row.cells).some((cell) => cell.total > 0)) return [];
  const label = [...new Set([clicks.first, clicks.last].filter((id): id is string => id !== undefined))].join(' · ');
  return [{ label, text: (id) => ratioText(clicks.row.cells[id]) }];
}

const judgeRows = (report: BenchReport): Row[] => report.judgeRows.map((row) => ({ label: row.key, text: (id) => spreadText('score', row.cells[id]) }));

function Cell({ text }: { text: CellText }) {
  return (
    <Part role="cell" className={`flex items-baseline gap-2 tabular-nums ${PAD}`}>
      {text.isBest ? <strong className="font-bold">{text.value}</strong> : <span>{text.value}</span>}
      {text.sub !== undefined && <>{' '}<small className="text-muted-foreground text-xs">{text.sub}</small></>}
    </Part>
  );
}

// The sub line: how many runs the median read, a yellow marker for the ones left out (or, with none out, intervened), and the slept ones
function Header({ arm }: { arm: ArmColumn }) {
  const count = arm.inMedian === arm.runs
    ? tPlural('benchmark.report.runs', arm.runs, { n: arm.runs })
    : tPlural('benchmark.report.medianOf', arm.inMedian, { n: arm.inMedian });
  const marker = arm.out > 0 ? t('benchmark.report.out', { n: arm.out })
    : arm.intervened > 0 ? tPlural('benchmark.report.intervenedCol', arm.intervened, { n: arm.intervened }) : undefined;
  return (
    <Part role="columnheader" className="flex flex-col gap-0.5 px-3.5 py-2">
      <span>{`${arm.letter} · ${arm.name}`}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-normal text-muted-foreground text-xs leading-4">
        <span>{arm.onlyPerRun ? `${count} · ${t('benchmark.report.onlyPerRun')}` : count}</span>
        {marker !== undefined && (
          <span className="flex items-center gap-1 text-waiting"><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{marker}</span>
        )}
        {arm.slept > 0 && (
          <span className="flex items-center gap-1"><MoonIcon aria-hidden="true" className="size-[11px]" />{tPlural('benchmark.report.sleptCol', arm.slept, { n: arm.slept })}</span>
        )}
      </span>
    </Part>
  );
}

function Section({ title, rows, arms, style }: SectionProps) {
  if (rows.length === 0) return null;
  return (
    <>
      <Part role="row" className={ROW} style={style}><Part role="rowheader" className={`text-muted-foreground text-xs ${PAD}`}>{title}</Part></Part>
      {rows.map((row) => (
        <Part key={row.label} role="row" className={ROW} style={style}>
          <Part role="rowheader" className={PAD}>{row.label}</Part>
          {arms.map((arm) => <Cell key={arm.armId} text={row.text(arm.armId)} />)}
        </Part>
      ))}
    </>
  );
}

/** The report's table (#467, benchmark.hv.html's .rel): the arms' headers, then execução, cenários de clique and juiz; a section with no row
 *  is left out. */
export function ReportTable({ report }: { report: BenchReport }) {
  const style = gridOf(report.arms.length);
  const { arms } = report;
  return (
    <div className="overflow-x-auto">
      <Part role="table" aria-label={t('benchmark.header.tab.report')} className="flex w-max min-w-full flex-col rounded-lg border text-[13px]">
        <Part role="row" className={`${ROW} rounded-t-lg bg-card font-semibold`} style={style}>
          <span />
          {arms.map((arm) => <Header key={arm.armId} arm={arm} />)}
        </Part>
        <Section title={t('benchmark.report.section.execution')} rows={executionRows(report)} arms={arms} style={style} />
        <Section title={t('benchmark.report.section.clicks')} rows={clickRows(report)} arms={arms} style={style} />
        <Section title={t('benchmark.report.section.judge')} rows={judgeRows(report)} arms={arms} style={style} />
      </Part>
    </div>
  );
}
