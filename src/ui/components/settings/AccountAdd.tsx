import { ArrowUpRightIcon, CircleAlertIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAccountAdd } from '@/hooks/use-account-add';
import { type MessageKey, t } from '@/i18n';
import { failedKey, type NameRefusal, REFUSAL_KEY } from '@/lib/account-add';
import { CLAUDE_ACCOUNT_NAME_MAX } from '../../../types';

// The accounts card's adds (#965, the handoff): an action at the right of Claude's and GitHub's headers and the flow at the group's foot,
// under the list. Neither touches the form's draft: an add calls its routes at once and only re-reads the list.

/** What an add hands its group: the header's action and the foot under the list. */
export interface AddSlots { action: ReactNode; foot: ReactNode }
interface AddProps { onConnected(): void; render(slots: AddSlots): ReactNode }

/** A waiting-coloured line in our own words, the route's being in the console, with its way out when it has one. */
export function FailedLine({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-waiting text-xs">
      <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{text}{children !== undefined && <>{' '}{children}</>}</span>
    </p>
  );
}

export function TextButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return <button type="button" className="text-review" onClick={onClick}>{children}</button>;
}

// Hidden in place while its flow is open, so the header's hint never reflows
function HeaderAdd({ label, isHidden, onClick }: { label: MessageKey; isHidden: boolean; onClick(): void }) {
  return <Button type="button" variant="ghost" size="sm" className={isHidden ? 'invisible ml-auto' : 'ml-auto'} onClick={onClick}>{t(label)}</Button>;
}

function SignInLink({ url, label }: { url: string; label: MessageKey }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-review">
      {t(label)}<ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
}

// On the rows' grid, at the end of the list: the spinner in the radio dot's place, in the working colour
function PendingRow({ label, hint, onCancel }: { label: string; hint: ReactNode; onCancel(): void }) {
  return (
    <div role="status" className="-mx-2 flex min-h-8 items-center gap-2.5 px-2 py-1.5">
      <span className="flex size-4 shrink-0 items-center justify-center text-working [&_svg]:size-4"><Spinner /></span>
      <span className="whitespace-nowrap text-sm">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground text-xs">{hint}</span>
      <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={onCancel}>{t('settings.accounts.add.cancel')}</Button>
    </div>
  );
}

// The eye sees the new row; a screen reader hears it (the handoff: no visible note)
function Done({ name }: { name?: string }) {
  // Always mounted: a screen reader may skip a live region that arrives already filled
  return <span role="status" className="sr-only">{name === undefined ? '' : t('settings.accounts.add.done', { name })}</span>;
}

interface NameFormProps { initialName: string; refusal?: NameRefusal; failure?: MessageKey; onSubmit(name: string): void; onCancel(): void }

// One line: the name, cancel and add (try again after a failure); under it the hint, or the failure's reason in its place, and a refusal
function NameForm({ initialName, refusal, failure, onSubmit, onCancel }: NameFormProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const refusalId = useId();
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Settings' own Escape, on document, skips a prevented key: the page stays; an IME's Escape dismisses its candidate only
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onCancel();
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); onSubmit(name); }}>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef} value={name} aria-label={t('settings.accounts.add.name.label')} placeholder={t('settings.accounts.add.name.label')}
          aria-invalid={refusal === undefined ? undefined : true} aria-describedby={refusal === undefined ? undefined : refusalId}
          className="h-8 w-[260px]" onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown}
        />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t('settings.accounts.add.cancel')}</Button>
        <Button type="submit" size="sm">{t(failure === undefined ? 'settings.accounts.add.submit' : 'settings.accounts.retry')}</Button>
      </div>
      {failure === undefined ? <p className="text-muted-foreground text-xs">{t('settings.accounts.add.name.hint')}</p> : <FailedLine text={t(failure)} />}
      {refusal !== undefined && <p id={refusalId} role="alert" className="text-destructive text-xs">{t(REFUSAL_KEY[refusal], { max: CLAUDE_ACCOUNT_NAME_MAX })}</p>}
    </form>
  );
}

const claudeHint = (url?: string): ReactNode => (
  <>{t('settings.accounts.add.claude.pending')}{url !== undefined && <>{' · '}<SignInLink url={url} label="settings.accounts.add.claude.link" /></>}</>
);

/** Claude's add (#965): a name first, then `claude setup-token`'s browser sign-in, its link shown once known. The form stays one element from
 * naming to failed and back, so a refusal after a failure keeps what was typed; a failure reopens it on the name the add was for. */
export function ClaudeAccountAdd({ onConnected, render }: AddProps) {
  const add = useAccountAdd('claude', onConnected);
  const [isNaming, setNaming] = useState(false);
  const { status } = add;
  // A wait resumed by the mount read takes over an open field: its end must not reopen the field unasked
  useEffect(() => { if (status.state === 'pending') setNaming(false); }, [status.state]);
  const submit = (name: string): void => { void add.start(name).then((outcome) => setNaming(outcome === 'refused')); };
  const close = (): void => { setNaming(false); add.dismiss(); };
  const isFormOpen = status.state === 'failed' || (status.state === 'idle' && isNaming);
  const foot = (
    <>
      {isFormOpen && (
        <NameForm
          initialName={status.state === 'failed' ? status.name : ''} refusal={add.refusal}
          failure={status.state === 'failed' ? failedKey(status) : undefined} onSubmit={submit} onCancel={close}
        />
      )}
      {status.state === 'pending' && <PendingRow label={status.name} hint={claudeHint(status.url)} onCancel={add.cancel} />}
      <Done name={add.added} />
    </>
  );
  const action = <HeaderAdd label="settings.accounts.add.claude" isHidden={isFormOpen || status.state === 'pending'} onClick={() => setNaming(true)} />;
  return render({ action, foot });
}

// The one-time code under the row, indented to the label: large enough to read and type, selected whole on a click
function GithubPending({ code, url, onCancel }: { code?: string; url?: string; onCancel(): void }) {
  const hint = t(code === undefined ? 'settings.accounts.add.github.waiting' : 'settings.accounts.add.github.typeCode');
  return (
    <>
      <PendingRow label={t('settings.accounts.add.github.newLogin')} hint={hint} onCancel={onCancel} />
      {code !== undefined && (
        <div className="flex flex-col gap-1 pl-[26px]">
          <p>
            <span className="sr-only">{t('settings.accounts.add.github.code')} </span>
            <span className="select-all font-mono font-semibold text-[20px] leading-7 tracking-[.08em]">{code}</span>
          </p>
          {url !== undefined && <span className="text-xs"><SignInLink url={url} label="settings.accounts.add.github.link" /></span>}
        </div>
      )}
    </>
  );
}

/** GitHub's add (#965): gh's browser login, started at once; while pending, the one-time code gh printed and the link to type it at. */
export function GithubLoginAdd({ onConnected, render }: AddProps) {
  const add = useAccountAdd('github', onConnected);
  const { status } = add;
  const start = (): void => { void add.start(); };
  const foot = (
    <>
      {status.state === 'pending' && <GithubPending code={status.code} url={status.url} onCancel={add.cancel} />}
      {status.state === 'failed' && (
        <div className="flex items-center gap-2">
          <FailedLine text={`${t(failedKey(status))} ·`}><TextButton onClick={start}>{t('settings.accounts.retry')}</TextButton></FailedLine>
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={add.dismiss}>{t('settings.accounts.add.close')}</Button>
        </div>
      )}
      <Done name={add.added} />
    </>
  );
  return render({ action: <HeaderAdd label="settings.accounts.add.github" isHidden={status.state !== 'idle'} onClick={start} />, foot });
}
