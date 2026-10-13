import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';

interface SettingSwitchProps {
  id: string;
  label: MessageKey;
  hint?: MessageKey; // #672: a switch the spec gives no hint has none
  checked: boolean;
  disabled?: boolean;
  anchor?: string; // the id the Settings search lands on (#689); the label's by default
  onCheckedChange(checked: boolean): void;
}

// One on/off setting (#198): the switch beside its label and hint, centred on both. A grid, not nested flex, keeps the label a
// sibling of the switch so it greys with it through `peer`.
export function SettingSwitch({ id, label, hint, checked, disabled, anchor, onCheckedChange }: SettingSwitchProps) {
  return (
    <div id={anchor ?? settingAnchor(label)} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
      <Switch className="row-span-2 self-center" id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id}>{t(label)}</Label>
      {hint && <p className="col-start-2 text-muted-foreground text-xs">{t(hint)}</p>}
    </div>
  );
}
