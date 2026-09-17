import { useEffect, useState } from 'react';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t, type MessageKey } from '@/i18n';
import { percent, PERCENT_MAX, QUOTA_RESERVE, usageTotals, windowLabel, withinLimit } from '@/lib/usage';
import type { Signal, State } from '../../types';

interface HeaderProps { state: State; locale: string; onConfigure(): void }

const SIGNAL_HINT: Record<Signal, MessageKey | undefined> = { green: undefined, yellow: 'signal.yellow', red: 'signal.red' };
const SIGNALS: Signal[] = ['green', 'yellow', 'red'];

const clock = (iso: string, locale: string): string => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

function commitMax(value: string): void {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) act('/config', { maxConcurrent: n });
}

export function Header({ state, locale, onConfigure }: HeaderProps) {
  const [maxInput, setMaxInput] = useState(String(state.maxConcurrent));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setMaxInput(String(state.maxConcurrent)); }, [state.maxConcurrent, focused]);

  const active = state.slots.filter((s) => s.status !== 'empty').length;
  const { hour, day } = usageTotals(state.usage, Date.now());
  const over = !withinLimit(hour, state.budget.maxTokensPerHour) || !withinLimit(day, state.budget.maxTokensPerDay);
  const meters: { key: string; label: string; used: number; limit: number }[] = [
    ...(state.budget.maxTokensPerHour ? [{ key: 'hour', label: t('usage.hour'), used: hour, limit: state.budget.maxTokensPerHour }] : []),
    ...(state.budget.maxTokensPerDay ? [{ key: 'day', label: t('usage.day'), used: day, limit: state.budget.maxTokensPerDay }] : []),
  ];
  const signalHint = SIGNAL_HINT[state.signal];
  const quota = state.boardQuota;

  return (
    <header className="flex flex-wrap items-center gap-4 border-b p-3">
      <span>{t('header.activeWorkers', { active, max: state.maxConcurrent })}</span>
      <label htmlFor="max-workers" className="flex items-center gap-2 text-muted-foreground">
        {t('maxWorkers')}
        <Input
          id="max-workers"
          type="number" min={0} step={1} className="w-16" value={maxInput}
          onFocus={() => setFocused(true)}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={() => { setFocused(false); commitMax(maxInput); }}
          onKeyDown={(e) => { if (e.key === 'Enter') commitMax(maxInput); }}
        />
      </label>
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single" value={state.signal}
          onValueChange={(signal) => { if (signal) act('/signal', { signal }); }}
        >
          {SIGNALS.map((signal) => <ToggleGroupItem key={signal} value={signal}>{signal}</ToggleGroupItem>)}
        </ToggleGroup>
        {signalHint && <span className="text-muted-foreground">{t(signalHint)}</span>}
      </div>
      <div className="flex flex-col gap-1 text-xs">
        {meters.map((m) => (
          <div key={m.key} className="flex items-center gap-2">
            <span>{`${m.label} ${percent(m.used, m.limit)}%`}</span>
            <Progress className="w-24" value={Math.min(percent(m.used, m.limit), PERCENT_MAX)} />
          </div>
        ))}
        {over && <span className="text-destructive">{t('usage.over')}</span>}
      </div>
      {state.rateLimits && (
        <div className="flex flex-col gap-1 text-xs" title={t('limits.at', { time: clock(state.rateLimits.at, locale) })}>
          {Object.entries(state.rateLimits.windows).map(([key, w]) => (
            <div key={key} className="flex items-center gap-2">
              <span>{`${windowLabel(key)} ${Math.round(w.usedPercent)}%`}</span>
              <Progress className="w-24" value={Math.min(w.usedPercent, PERCENT_MAX)} />
              <span>{t('limits.resets', { time: clock(w.resetsAt, locale) })}</span>
            </div>
          ))}
        </div>
      )}
      {quota && (
        <span className={quota.remaining < QUOTA_RESERVE ? 'text-destructive' : 'text-muted-foreground'}>
          {`GitHub ${quota.remaining.toLocaleString(locale)}/${quota.limit.toLocaleString(locale)} · ${t('limits.resets', { time: clock(quota.resetsAt, locale) })}`}
        </span>
      )}
      <Button type="button" variant="outline" onClick={() => act('/board/refresh')}>{t('header.refresh')}</Button>
      <Button type="button" onClick={onConfigure}>{t('header.configure')}</Button>
      {state.lastPolledAt && <span className="ml-auto text-muted-foreground">{`board: ${clock(state.lastPolledAt, locale)}`}</span>}
    </header>
  );
}
