import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import type { SetupDraft } from '@/lib/setup-form';
import type { Language, WorkersMode } from '../../../types';

interface GeneralTabProps { draft: SetupDraft; onChange(patch: Partial<SetupDraft>): void }

export function GeneralTab({ draft, onChange }: GeneralTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="setup-language">{t('setup.language')}</Label>
        <Select value={draft.language} onValueChange={(v) => onChange({ language: v as Language })}>
          <SelectTrigger id="setup-language"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pt">português</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setup-workers">{t('setup.workers')}</Label>
        <Select value={draft.workers} onValueChange={(v) => onChange({ workers: v as WorkersMode })}>
          <SelectTrigger id="setup-workers"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="embedded">{t('setup.workers.embedded')}</SelectItem>
            <SelectItem value="iterm">{t('setup.workers.iterm')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
