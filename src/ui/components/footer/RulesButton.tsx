import { useState } from 'react';
import type { EffectiveLimits, State } from '../../../types';
import { RulesPanel } from '@/components/footer/RulesPanel';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { effectsInForce, type RulesForm, rulesLabel } from '@/lib/rule-effects';

interface RulesButtonProps { state: State; effective: EffectiveLimits; locale: string; form: RulesForm; onEditRules?(): void }

// The footer's chip box (handoff 02).
const CHIP = 'h-auto gap-1.5 rounded-sm px-2 py-px text-xs font-normal text-foreground';
// Half of the 30px footer less the 20px chip: the panel's borderless bottom edge meets the footer's top border (#224).
const RULES_PANEL_OFFSET = 5;
// The usage panel's look (UsagePanel, #223): popover surface, a border without the bottom edge, rounded on the top corners only.
const PANEL = 'flex max-h-[440px] w-[480px] flex-col overflow-hidden rounded-t-[8px] rounded-b-none border border-b-0 bg-popover p-0 text-xs text-popover-foreground';

/** The footer's rules button (#224, handoff §3.3): `regras` and the effects in force, opening the rules panel anchored to it. */
export function RulesButton({ state, effective, locale, form, onEditRules }: RulesButtonProps) {
  const [open, setOpen] = useState(false);
  const effects = effectsInForce(effective);
  const label = rulesLabel(effects, form);
  const close = () => setOpen(false);
  // Settings opens over the window: a panel left open behind it would be stale
  const editRules = onEditRules && (() => { close(); onEditRules(); });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className={CHIP} title={label.title}>
          <span>{t('footer.rules')}</span>{' '}
          <span className={effects.length === 0 ? 'text-muted-foreground' : undefined}>{label.text}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={RULES_PANEL_OFFSET} aria-label={t('rules.panel.title')} className={PANEL}>
        <RulesPanel state={state} effective={effective} locale={locale} onEditRules={editRules} onClose={close} />
      </PopoverContent>
    </Popover>
  );
}
