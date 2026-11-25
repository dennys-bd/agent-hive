import { type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { JiraConnectOutcome, JiraLogin } from '@/hooks/use-jira-sites';
import { t } from '@/i18n';
import { JIRA_FORM_KEYS, REFUSAL_KEY, REFUSAL_RECONNECT_KEY } from './jira-keys';

/** Where the token is created; the system browser opens it (the same `<a target="_blank">` the other external links use). */
export const ATLASSIAN_TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

interface JiraConnectFormProps {
  site?: string; // set: reconnecting that site, shown read-only
  onSubmit(login: JiraLogin): Promise<JiraConnectOutcome>;
  onClose(): void;
}

interface FieldProps { id: string; label: string; hint: ReactNode; children: ReactNode }

export function Field({ id, label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[13px]">{label}</Label>
      {children}
      <span id={`${id}-hint`} className="text-muted-foreground text-xs">{hint}</span>
    </div>
  );
}

/** The connect form, inline at the card's foot (#817). Refusals show here, never as a toast; the token lives only in this state and goes
 * away with the form. */
export function JiraConnectForm({ site: fixedSite, onSubmit, onClose }: JiraConnectFormProps) {
  const id = useId();
  const isReconnect = fixedSite !== undefined;
  const [site, setSite] = useState(fixedSite ?? '');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [isPending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<JiraConnectOutcome>();
  const refusal = outcome === undefined || outcome === 'connected' || outcome === 'failed' ? undefined : outcome;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (isPending) return;
    setPending(true);
    setOutcome(undefined);
    const result = await onSubmit({ site, email, token });
    if (result === 'connected') return onClose(); // the listing reloaded; this form unmounts with its token
    setPending(false);
    setOutcome(result);
  };
  const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !isPending) onClose(); }; // a running connect would save with no form left to show it
  const input = (name: string, value: string, set: (v: string) => void, extra: ComponentProps<typeof Input> = {}) => (
    <Input id={`${id}-${name}`} value={value} onChange={(e) => set(e.target.value)} aria-describedby={`${id}-${name}-hint`} {...extra} />
  );
  const siteHint = refusal === 'invalid-site'
    ? <span className="text-destructive">{t(REFUSAL_KEY[refusal])}</span>
    : t('settings.connections.jira.siteHint');
  const tokenHint = (
    <>
      {t(isReconnect ? 'settings.connections.jira.tokenHintReconnect' : 'settings.connections.jira.tokenHint')} ·{' '}
      <a href={ATLASSIAN_TOKENS_URL} target="_blank" rel="noreferrer" className="text-review">{t(JIRA_FORM_KEYS.tokenLink)}</a>
    </>
  );
  return (
    <form onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} className="flex flex-col gap-3 border-t px-5 py-4">
      <div className={`flex flex-col gap-3 ${isPending ? 'pointer-events-none opacity-60' : ''}`}>
        <Field id={`${id}-site`} label={t(JIRA_FORM_KEYS.site)} hint={siteHint}>
          {input('site', site, setSite, {
            readOnly: isReconnect, autoFocus: !isReconnect, placeholder: t('settings.connections.jira.sitePlaceholder'), 'aria-invalid': refusal === 'invalid-site' || undefined,
          })}
        </Field>
        <Field id={`${id}-email`} label={t(JIRA_FORM_KEYS.email)} hint={t('settings.connections.jira.emailHint')}>
          {input('email', email, setEmail, { type: 'email', autoFocus: isReconnect, placeholder: t('settings.connections.jira.emailPlaceholder') })}
        </Field>
        <Field id={`${id}-token`} label={t(JIRA_FORM_KEYS.token)} hint={tokenHint}>
          {input('token', token, setToken, { type: 'password', autoComplete: 'off' })}
        </Field>
      </div>
      {refusal !== undefined && refusal !== 'invalid-site' && (
        <p role="alert" className="text-destructive text-xs">{t((isReconnect ? REFUSAL_RECONNECT_KEY : REFUSAL_KEY)[refusal])}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>{t(JIRA_FORM_KEYS.cancel)}</Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? <><Spinner /> {t('settings.connections.jira.connecting')}</> : t(isReconnect ? JIRA_FORM_KEYS.reconnect : JIRA_FORM_KEYS.submit)}
        </Button>
      </div>
    </form>
  );
}
