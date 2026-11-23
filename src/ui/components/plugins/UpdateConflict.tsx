import type { UpdateChoice, UpdateConflict } from '../../../types';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { savedLabel } from '@/lib/plugins';
import { type SideLine, sideAgainstBase } from '@/lib/update-diff';

// The design system's diff grounds (#270) under the line, the status colour on its mark only (decision 17)
export const LOOK: Record<SideLine['mark'], { ground: string; mark: string }> = {
  ' ': { ground: '', mark: 'text-muted-foreground' },
  '+': { ground: 'bg-diff-add', mark: 'text-working' },
  '−': { ground: 'bg-diff-del', mark: 'text-destructive' },
};

function Lines({ lines }: { lines: SideLine[] }) {
  return (
    <div className="overflow-x-auto whitespace-pre font-mono text-xs">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the side, which is all that tells two alike apart
        <div key={index} data-mark={line.mark} className={LOOK[line.mark].ground}>
          <span className={`inline-block w-5 select-none ${LOOK[line.mark].mark}`}>{line.mark}</span>{line.text}
        </div>
      ))}
    </div>
  );
}

interface SideProps {
  title: string; meta?: string; lines: readonly string[] | null; base: readonly string[]; label: MessageKey; isChosen: boolean; isDimmed: boolean;
  onChoose(): void;
}

// One column (decisions 8, 9): its header, its side against base, or "file deleted" where that side has no such file, and its choice under a line
function Side({ title, meta, lines, base, label, isChosen, isDimmed, onChoose }: SideProps) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-1 flex-col rounded-lg border ${isChosen ? 'border-foreground' : ''} ${isDimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">{title}</span>
        {meta && <span className="text-muted-foreground">{meta}</span>}
      </div>
      <div className="px-3 py-2">
        {lines === null ? <p className="text-muted-foreground text-xs">{t('plugins.update.fileDeleted')}</p> : <Lines lines={sideAgainstBase(base, lines)} />}
      </div>
      <div className="border-t px-3 py-2">
        <Button type="button" variant="outline" size="xs" aria-pressed={isChosen} onClick={onChoose} className={isChosen ? 'border-foreground bg-accent' : ''}>{t(label)}</Button>
      </div>
    </section>
  );
}

export interface ConflictBlockProps { conflict: UpdateConflict; to?: string; editedAt?: string; choice?: UpdateChoice; onChoose(choice: UpdateChoice): void }

// #492: the passage's lines in the version's text; a whole-file conflict has none, so the heading stands alone
const placeOf = ({ heading, lines }: UpdateConflict): string =>
  lines === undefined ? heading : `${heading} · ${t('plugins.update.lines', { start: lines.start, end: lines.end })}`;

/** One conflict of a version's update (#325, handoff 11d): a red dot, "conflict" and where, then "your version" and "new from the hive" side by
 * side, each against the merge base with its button. The chosen side's border is the foreground and the other column dims; a choice changes
 * until apply. */
export function ConflictBlock({ conflict, to, editedAt, choice, onChoose }: ConflictBlockProps) {
  const sides = [
    { side: 'mine', title: t('plugins.update.yours'), meta: editedAt && t('plugins.update.edited', { date: savedLabel(editedAt) }), lines: conflict.mine, label: 'plugins.update.keepMine' },
    { side: 'hive', title: t('plugins.update.fromHive'), meta: to && t('plugins.update.hiveSide', { version: to }), lines: conflict.hive, label: 'plugins.update.useHive' },
  ] as const;
  return (
    <article aria-label={conflict.heading} className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 font-normal text-sm">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
        <span className="font-medium">{t('plugins.update.conflict')}</span>
        <span className="font-mono text-muted-foreground text-xs">{placeOf(conflict)}</span>
      </h3>
      <div className="flex gap-3">
        {sides.map(({ side, title, meta, lines, label }) => (
          <Side
            key={side} title={title} meta={meta} lines={lines} base={conflict.base} label={label} isChosen={choice === side}
            isDimmed={choice !== undefined && choice !== side} onChoose={() => onChoose(side)}
          />
        ))}
      </div>
    </article>
  );
}
