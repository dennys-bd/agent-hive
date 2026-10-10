import { act } from '@/components/actions';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';
import { describeRules } from '@/lib/usage';
import type { EffectiveLimits, Signal, SignalSettings } from '../../types';

export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];

/** The manual signal, at the top of the flow sidebar (redesign 09): its label, a full-width toggle and what the pressed signal's row holds
 * back (#727; none on green). Items looser than the floor a fired rule imposes are disabled and name the rules; the pressed item stays the stored signal even
 * when disabled, so the toggle shows what the user chose and the footer what is in force. Nothing is locked before the first events payload. */
export function SignalToggle({ signal, signals, effective }: { signal: Signal; signals: SignalSettings; effective?: EffectiveLimits }) {
  const floor = SIGNALS.indexOf(effective?.floor.signal ?? 'green');
  const lockTitle = effective && t('signal.locked', { rules: describeRules(effective.signalRules) });
  const hint = signalEffect(signal, signals);
  return (
    <div className="flex flex-col gap-2">
      <span id="signal-label" className="text-muted-foreground text-xs">{t('flow.signal')}</span>
      <ToggleGroup
        type="single" size="xs" aria-labelledby="signal-label" className="w-full gap-0.5 bg-muted p-0.5" value={signal}
        onValueChange={(next) => { if (next) act('/signal', { signal: next }); }}
      >
        {SIGNALS.map((item, rank) => (
          <ToggleGroupItem
            key={item} value={item} data-signal={item} disabled={rank < floor} title={rank < floor ? lockTitle : undefined}
            className="flex-1 rounded-sm! font-medium"
          >
            {item}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}
