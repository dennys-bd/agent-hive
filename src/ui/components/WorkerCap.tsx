import { useEffect, useState } from 'react';
import { act } from '@/components/actions';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { describeRules } from '@/lib/usage';
import { type EffectiveLimits, MAX_CONCURRENT_MAX, type State } from '../../types';
import { workerCount } from '../../worker-count';

interface WorkerCapProps { state: State; effective?: EffectiveLimits }

// Integer from 0 to MAX_CONCURRENT_MAX (the server refuses more), posted only when it differs from the stored value (compared before clamping: a blur without edits under a cap must not
// rewrite a stored 5 into 4), clamped to the rule cap when there is one: typing 7 under a cap of 4 stores 4.
function commitMax(value: string, current: number, cap?: number): void {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONCURRENT_MAX || n === current) return;
  act('/config', { maxConcurrent: cap === undefined ? n : Math.min(n, cap) });
}

/** The max workers control (#146): the active/max counter and the editable cap, under the signal in the flow sidebar (redesign 09).
 * One compact line, `shrink-0` so it never shrinks under them. `maxWorkers.locked` names the rule when a fired usage
 * rule caps the value (#142 behaviour unchanged); the counter reads the effective cap, the field the configured value (#178). */
export function WorkerCap({ state, effective }: WorkerCapProps) {
  const [maxInput, setMaxInput] = useState(String(state.maxConcurrent));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setMaxInput(String(state.maxConcurrent)); }, [state.maxConcurrent, focused]);

  const active = workerCount(state.workers);
  const cap = effective?.floor.maxWorkers;
  const capTitle = effective && cap !== undefined ? t('maxWorkers.locked', { rules: describeRules(effective.capRules) }) : undefined;

  return (
    <div className="flex shrink-0 items-center gap-2 text-[13px]">
      <span className="font-medium">{t('footer.workers', { active, max: effective?.maxWorkers ?? state.maxConcurrent })}</span>
      <label htmlFor="max-workers" className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
        {t('footer.max')}
        <Input
          id="max-workers"
          type="number" min={0} max={cap ?? MAX_CONCURRENT_MAX} step={1} className="h-7 w-16 px-2 text-[13px] text-foreground" value={maxInput} title={capTitle}
          onFocus={() => setFocused(true)}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={() => { setFocused(false); commitMax(maxInput, state.maxConcurrent, cap); }}
          onKeyDown={(e) => { if (e.key === 'Enter') commitMax(maxInput, state.maxConcurrent, cap); }}
        />
      </label>
    </div>
  );
}
