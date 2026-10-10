import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { withHost } from '@/lib/settings-form';

interface TrustedDomainsGroupProps {
  hosts: string[];
  onChange(hosts: string[]): void;
}

// Trusted domain chips (#404, #513): a host per Badge, an input that adds one on Enter or on blur. A bad host stays in the input with the
// error under it, so a typed host is never lost silently.
export function TrustedDomainsGroup({ hosts, onChange }: TrustedDomainsGroupProps) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);

  function add(): void {
    const next = withHost(hosts, text);
    if (!next) { setBad(true); return; }
    setText('');
    setBad(false);
    if (next.length !== hosts.length) onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  }

  function onBlur(): void {
    if (text.trim() !== '') add();
  }

  return (
    <SettingsGroup title="settings.trustedDomains" hint="settings.trustedDomains.hint">
      <div className="flex flex-wrap items-center gap-2">
        {hosts.map((host) => (
          <Badge key={host} variant="secondary">
            {host}
            <button type="button" aria-label={t('settings.trustedDomains.remove', { host })} onClick={() => onChange(hosts.filter((h) => h !== host))}>
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          className="w-60" aria-label={t('settings.trustedDomains.add')} placeholder={t('settings.trustedDomains.add')} aria-invalid={bad}
          value={text} onChange={(e) => { setText(e.target.value); setBad(false); }} onKeyDown={onKeyDown} onBlur={onBlur}
        />
      </div>
      {bad && <p className="text-destructive text-xs">{t('settings.error.trustedDomain', { host: text.trim().toLowerCase() })}</p>}
    </SettingsGroup>
  );
}
