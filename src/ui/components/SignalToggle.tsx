import { useContext } from 'react';
import { act } from '@/components/actions';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/i18n';
import { describeRules } from '@/lib/usage';
import type { EffectiveLimits, Signal } from '../../types';

export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];

/** The manual signal's segmented control (#573): the header popover and the tasks sidebar's automação each put their own context around it
 * (a label and the effect hint up there, the active signal's rows down here). Items looser than the floor a fired rule imposes are disabled
 * and name the rules; the pressed item stays the stored signal even when disabled, so the toggle shows what the user chose and the footer
 * what is in force. Nothing is locked before the first events payload. */
export function SignalToggle({ signal, effective }: { signal: Signal; effective?: EffectiveLimits }) {
  const floor = SIGNALS.indexOf(effective?.floor.signal ?? 'green');
  const defaultAgent = useContext(DefaultAgentContext);
  const lockTitle = effective && t('signal.locked', { rules: describeRules(effective.signalRules, defaultAgent) });
  return (
    <ToggleGroup
      type="single" size="xs" aria-label={t('flow.signal')} className="w-full gap-0.5 bg-muted p-0.5" value={signal}
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
  );
}
