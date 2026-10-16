import type { UpdateChoice, UpdateConflict } from '../../../types';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { type SideLine, sideAgainstBase } from '@/lib/update-diff';

// The design system's diff grounds (#270) under the line, the status colour on its mark only (decision 17)
const LOOK: Record<SideLine['mark'], { ground: string; mark: string }> = {
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
          <span className={`inline-block w-4 select-none ${LOOK[line.mark].mark}`}>{line.mark}</span>{line.text}
        </div>
      ))}
    </div>
  );
}

interface SideProps { title: string; lines: readonly string[] | null; base: readonly string[]; label: MessageKey; isChosen: boolean; isDimmed: boolean; onChoose(): void }

// One column (decisions 8, 9): its side against base, or "file deleted" where that side has no such file
function Side({ title, lines, base, label, isChosen, isDimmed, onChoose }: SideProps) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-3 ${isDimmed ? 'opacity-45' : ''}`}>
      <span className="font-medium text-xs">{title}</span>
      {lines === null ? <p className="text-muted-foreground text-xs">{t('plugins.update.fileDeleted')}</p> : <Lines lines={sideAgainstBase(base, lines)} />}
      <Button type="button" variant="outline" size="sm" aria-pressed={isChosen} onClick={onChoose} className="self-start">{t(label)}</Button>
    </section>
  );
}

export interface ConflictBlockProps { conflict: UpdateConflict; to?: string; choice?: UpdateChoice; onChoose(choice: UpdateChoice): void }

/** One conflict of a version's update (#325, handoff 11d): its heading and file, then "your version" and "new from the hive" side by side,
 * each against the merge base with its button. The chosen side's button is pressed and the other column dims; a choice changes until apply. */
export function ConflictBlock({ conflict, to, choice, onChoose }: ConflictBlockProps) {
  const fromHive = to === undefined ? t('plugins.update.fromHive') : `${t('plugins.update.fromHive')} · ${to}`;
  const sides = [
    { side: 'mine', title: t('plugins.update.yours'), lines: conflict.mine, label: 'plugins.update.keepMine' },
    { side: 'hive', title: fromHive, lines: conflict.hive, label: 'plugins.update.useHive' },
  ] as const;
  return (
    <article aria-label={conflict.heading} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 text-xs"><span className="font-medium font-mono">{conflict.heading}</span><span className="font-mono text-muted-foreground">{conflict.file}</span></div>
      <div className="flex gap-3">
        {sides.map(({ side, title, lines, label }) => (
          <Side key={side} title={title} lines={lines} base={conflict.base} label={label} isChosen={choice === side} isDimmed={choice !== undefined && choice !== side} onChoose={() => onChoose(side)} />
        ))}
      </div>
    </article>
  );
}
