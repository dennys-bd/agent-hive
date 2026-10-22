import { type ReactNode, useEffect, useState } from 'react';
import { canonicalJson, sha256Hex } from '../../../../benchmark/canonical.js';
import type { Arm, BenchTask, Experiment } from '../../../../types';
import { type ArmRow, armRows, countText, sameRows } from '@/components/benchmark/arms/arm-rows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export const TASKS_HASH_CHARS = 4;

// The arm's own tasks hash, which #459 left to the reader: Web Crypto over the canonical JSON, as tasksHash on the server. Where Web Crypto is
// missing (jsdom) the row shows no hash rather than a wrong one, so the rejection is dropped on purpose
export function useTasksHash(tasks: readonly BenchTask[] | undefined): string | undefined {
  const text = tasks === undefined ? undefined : canonicalJson(tasks);
  const [hash, setHash] = useState<string>();
  useEffect(() => {
    setHash(undefined);
    if (text === undefined) return undefined;
    let isLive = true;
    sha256Hex(text).then((hex) => { if (isLive) setHash(hex.slice(0, TASKS_HASH_CHARS)); }, () => undefined);
    return () => { isLive = false; };
  }, [text]);
  return hash;
}

export function CardFooter({ text, onOpen }: { text: string; onOpen(): void }) {
  return (
    <footer className="mt-auto flex flex-wrap items-center gap-2 border-t px-3.5 py-2 text-muted-foreground text-xs">
      <span className="min-w-0 flex-[1_1_120px]">{text}</span>
      <Button type="button" size="sm" variant="outline" onClick={onOpen}>{t('benchmark.arms.open')}</Button>
    </footer>
  );
}

// Values wrap, never truncate; the struck line is the base's value under an overridden row
function RowList({ rows, tasksHash }: { rows: readonly ArmRow[]; tasksHash?: string }) {
  return (
    <dl className="m-0 flex flex-col gap-2 px-3.5 py-3 text-[13px]">
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2">
          <dt className="text-muted-foreground text-xs">{t(row.label)}</dt>
          <dd className="m-0 flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
            <span><span>{row.value}</span>{row.key === 'tasks' && tasksHash !== undefined && <span className="font-mono text-xs">{` · t·${tasksHash}`}</span>}</span>
            {row.was !== undefined && <span className="text-muted-foreground text-xs line-through">{row.was}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ArmCardProps { experiment: Experiment; arm: Arm; onOpen(): void; name?: ReactNode; menu?: ReactNode }

/** One arm (#462, the screen's arm cards): letter, name, count, its overridden rows, the yellow line when its tasks differ from the base's (the
 *  same test as report.ts's só por run), and the footer. Task 7 passes the rename field and the ⋯ menu through `name` and `menu`. */
export function ArmCard({ experiment, arm, onOpen, name, menu }: ArmCardProps) {
  const rows = armRows(experiment.base, arm.overrides);
  const overridden = rows.filter((r) => r.overridden);
  const hasOwnTasks = overridden.some((r) => r.key === 'tasks');
  const tasksHash = useTasksHash(hasOwnTasks ? arm.overrides.tasks : undefined);
  return (
    <section aria-label={t('benchmark.arms.cardLabel', { letter: arm.letter })} className="flex min-w-0 flex-col rounded-xl border bg-card shadow-sm">
      <header className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <Badge variant="secondary">{arm.letter}</Badge>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {name ?? <b className="whitespace-nowrap font-semibold text-sm">{arm.name}</b>}
          <small className="text-muted-foreground text-xs">{countText(overridden.length)}</small>
        </span>
        {menu}
      </header>
      {overridden.length === 0 ? <p className="px-3.5 py-3 text-[13px] text-muted-foreground">{t('benchmark.arms.none')}</p> : <RowList rows={overridden} tasksHash={tasksHash} />}
      {hasOwnTasks && <p className="flex items-start gap-1.5 px-3.5 pb-2.5 text-waiting text-xs"><span aria-hidden="true">●</span><span>{t('benchmark.arms.tasksWarning')}</span></p>}
      <CardFooter text={sameRows(rows)} onOpen={onOpen} />
    </section>
  );
}
