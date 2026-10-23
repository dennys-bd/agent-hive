import type { BenchRunStatus, TaskProgressState } from '../../../../types';
import { type CardAction, hoursMinutes, type RunCardRow } from '@/components/benchmark/execution/execution-rows';
import { tokensText } from '@/components/benchmark/execution/run-text';
import { type MessageKey, t } from '@/i18n';

// The screen's run states; colour only for status: ok, wait, bad, queued, done (sleeping as the header's sleeping chip)
const STATE: Record<BenchRunStatus, { key: MessageKey; className: string }> = {
  running: { key: 'benchmark.execution.state.running', className: 'text-working' },
  waiting: { key: 'benchmark.execution.state.waiting', className: 'text-waiting' },
  sleeping: { key: 'benchmark.execution.state.sleeping', className: 'text-muted-foreground' },
  done: { key: 'benchmark.execution.state.done', className: 'text-muted-foreground' },
  timeout: { key: 'benchmark.execution.state.timeout', className: 'text-destructive' },
  error: { key: 'benchmark.execution.state.error', className: 'text-destructive' },
  interrupted: { key: 'benchmark.execution.state.interrupted', className: 'text-destructive' },
  queued: { key: 'benchmark.execution.state.queued', className: 'text-empty' },
};
const SEGMENT: Record<TaskProgressState, string> = { done: 'bg-working', waiting: 'bg-waiting', open: 'bg-border' };
const ACTION: Record<CardAction, MessageKey> = { open: 'benchmark.execution.card.open', result: 'benchmark.execution.card.result' };

/** One run of a round (#465, the screen's .run): arm badge, short token, state, the task bar, delivered, tokens, time, and abrir / resultado. */
export function RunCard({ card, onAction }: { card: RunCardRow; onAction(card: RunCardRow): void }) {
  const state = STATE[card.status];
  return (
    <article aria-label={t('benchmark.execution.card.label', { letter: card.letter })} className="flex flex-col gap-2.5 rounded-lg border px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="flex size-5 flex-none items-center justify-center rounded-[5px] bg-accent text-[11px]">{card.letter}</span>
        <span className="font-mono text-muted-foreground text-xs">{card.shortToken}</span>
        <span className={`ml-auto flex items-center gap-1.5 text-xs ${state.className}`}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{t(state.key)}</span>
      </div>
      <div aria-hidden="true" className="flex gap-[3px]">
        {card.segments.map((segment, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its task's place in the seed order, which is all that tells two alike apart
          <span key={i} data-segment={segment} className={`h-1 flex-1 rounded-sm ${SEGMENT[segment]}`} />
        ))}
      </div>
      <div className="flex min-h-[18px] items-start gap-4 text-muted-foreground text-xs">
        <span>{t('benchmark.execution.card.delivered', { delivered: card.delivered, total: card.total })}</span>
        {card.tokens !== undefined && <span>{t('benchmark.execution.run.tokens', { n: tokensText(card.tokens) })}</span>}
        {card.ms !== undefined && <span>{hoursMinutes(card.ms)}</span>}
        {card.action !== undefined && (
          <button type="button" className="ml-auto text-foreground hover:underline" onClick={() => onAction(card)}>{t(ACTION[card.action])}</button>
        )}
      </div>
    </article>
  );
}
