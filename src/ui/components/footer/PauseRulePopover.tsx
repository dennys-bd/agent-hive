import { type FormEvent, type ReactNode, useState } from 'react';
import type { DisableUntil, State, UsageRule } from '../../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type MessageKey, t } from '@/i18n';
import { clock, countdown, nextMorning, type PauseChoice, pauseUntil, ruleTarget, windowResetsAt } from '@/lib/usage';

function MenuItem({ onClick, hint, muted, children }: { onClick(): void; hint?: string; muted?: boolean; children: ReactNode }) {
  return (
    <Button
      type="button" variant="ghost" onClick={onClick}
      className={`h-auto w-full justify-between rounded-sm px-2 py-1.5 text-[13px] font-normal ${muted ? 'text-muted-foreground' : ''}`}
    >
      <span>{children}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Button>
  );
}

// personalizado… (02): a native date and time field, posted only once it is in the future.
function CustomPause({ onPause }: { onPause(until: DisableUntil): void }) {
  const [value, setValue] = useState('');
  const at = Date.parse(value); // datetime-local has no offset, so it parses as local time
  const valid = Number.isFinite(at) && at > Date.now();
  const submit = (e: FormEvent) => { e.preventDefault(); if (valid) onPause({ kind: 'at', at: new Date(at).toISOString() }); };
  return (
    <form onSubmit={submit} className="flex items-center gap-1 px-1 py-1">
      <Input type="datetime-local" aria-label={t('pause.customLabel')} value={value} onChange={(e) => setValue(e.target.value)} className="h-7 text-xs" />
      <Button type="submit" size="xs" disabled={!valid}>{t('pause.customApply')}</Button>
    </form>
  );
}

const FIXED: { choice: Exclude<PauseChoice, 'reset' | 'tomorrow'>; key: MessageKey }[] = [
  { choice: 'quarter', key: 'pause.quarter' }, { choice: 'hour', key: 'pause.hour' }, { choice: 'fourHours', key: 'pause.fourHours' },
];

interface PauseRulePopoverProps { rule: UsageRule; paused: boolean; state: State; locale: string; onEditRules?(): void; children: ReactNode }

/** A rule's pausar regra popover (02, #224): the horizons, personalizado…, retomar agora while paused, and a way to the rules. The trigger is
 * the caller's: the rules panel's row. */
export function PauseRulePopover({ rule, paused, state, locale, onEditRules, children }: PauseRulePopoverProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const now = Date.now();
  const resetAt = windowResetsAt(state, rule); // #929: its own agent's window
  const close = () => { setOpen(false); setCustom(false); };
  const pause = (until: DisableUntil) => { close(); void act('/rules/disable', { ...ruleTarget(rule), until }); };
  const resume = () => { close(); void act('/rules/enable', ruleTarget(rule)); };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" aria-label={t('pause.title')} className="flex w-[244px] flex-col p-1">
        <div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{t('pause.title')}</div>
        {paused && <MenuItem onClick={resume}>{t('pause.resume')}</MenuItem>}
        <MenuItem onClick={() => pause(pauseUntil('reset', now))} hint={resetAt && countdown(resetAt, now)}>{t('pause.reset')}</MenuItem>
        {FIXED.map(({ choice, key }) => <MenuItem key={choice} onClick={() => pause(pauseUntil(choice, now))}>{t(key)}</MenuItem>)}
        <MenuItem onClick={() => pause(pauseUntil('tomorrow', now))} hint={clock(nextMorning(now).toISOString(), locale)}>{t('pause.tomorrow')}</MenuItem>
        {custom ? <CustomPause onPause={pause} /> : <MenuItem onClick={() => setCustom(true)}>{t('pause.custom')}</MenuItem>}
        {onEditRules && (
          <>
            <div className="-mx-1 my-1 h-px bg-border" />
            <MenuItem muted onClick={() => { close(); onEditRules(); }}>{t('pause.edit')}</MenuItem>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
