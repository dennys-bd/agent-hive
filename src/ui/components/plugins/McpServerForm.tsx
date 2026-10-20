import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Confirm } from '@/components/Confirm';
import { ScopeSelect, targetOf } from '@/components/plugins/McpServerRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { McpServerRow as Row, ServerDraft } from '@/hooks/use-mcp';
import { type MessageKey, t } from '@/i18n';

type Kind = 'command' | 'url';
interface Fields { name: string; kind: Kind; commandLine: string; url: string; header: string; value: string; isCleared: boolean; scope: string | null }
type SetFields = (patch: Partial<Fields>) => void;

const EMPTY: Fields = { name: '', kind: 'command', commandLine: '', url: '', header: '', value: '', isCleared: false, scope: null };
const FIELD = 'h-8 text-sm';

// An edit starts from the row; the saved value is never read back (the route answers hasValue only), so its field starts empty
function fieldsOf(server: Row | undefined): Fields {
  if (server === undefined) return EMPTY;
  const base: Fields = { ...EMPTY, name: server.name, scope: server.workspace };
  return 'url' in server ? { ...base, kind: 'url', url: server.url, header: server.authHeader ?? '' } : { ...base, commandLine: targetOf(server) };
}

// A typed value is stored, a cleared one deleted, an untouched one left as it is
function headerValueOf({ value, isCleared }: Fields): string | null | undefined {
  if (value !== '') return value;
  return isCleared ? null : undefined;
}

// The definition the fields describe. ponytail: the command line splits on whitespace into the argv (never through a shell), so a new
// argument holding a space cannot be written; add quoting when a server needs one. An edit that leaves the line as it opened keeps the
// saved argv, so a rename or a scope change never splits an argument that holds a space
function draftOf(fields: Fields, server: Row | undefined): ServerDraft {
  const base = { name: fields.name.trim(), workspace: fields.scope, on: server?.on ?? true };
  if (fields.kind === 'command') {
    if (server !== undefined && !('url' in server) && fields.commandLine === targetOf(server)) return { server: { ...base, command: server.command, args: server.args } };
    const [command = '', ...args] = fields.commandLine.trim().split(/\s+/);
    return { server: { ...base, command, args } };
  }
  const url = fields.url.trim();
  const header = fields.header.trim();
  if (header === '') return { server: { ...base, url } }; // no header, no value: the route stores one only for a named header
  return { server: { ...base, url, authHeader: header }, value: headerValueOf(fields) };
}

function placeholderOf(hasValue: boolean, isCleared: boolean): MessageKey {
  if (isCleared) return 'plugins.mcp.form.valueCleared';
  return hasValue ? 'plugins.mcp.form.valueSaved' : 'plugins.mcp.form.value';
}

function KindSelect({ kind, onChange }: { kind: Kind; onChange(kind: Kind): void }) {
  return (
    <Select value={kind} onValueChange={(value) => onChange(value === 'url' ? 'url' : 'command')}>
      <SelectTrigger size="sm" aria-label={t('plugins.mcp.form.kind')}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="command">{t('plugins.mcp.form.command')}</SelectItem>
        <SelectItem value="url">{t('plugins.mcp.form.url')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

// The value is a password field: the screen never shows a value, typed or saved
function UrlFields({ fields, hasValue, set }: { fields: Fields; hasValue: boolean; set: SetFields }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={t('plugins.mcp.form.url')} placeholder={t('plugins.mcp.form.url')} value={fields.url} onChange={(e) => set({ url: e.target.value })} className={`${FIELD} min-w-64 flex-1 font-mono`} />
      <Input aria-label={t('plugins.mcp.form.header')} placeholder={t('plugins.mcp.form.header')} value={fields.header} onChange={(e) => set({ header: e.target.value })} className={`${FIELD} max-w-44 font-mono`} />
      <Input
        type="password" autoComplete="new-password" aria-label={t('plugins.mcp.form.value')} placeholder={t(placeholderOf(hasValue, fields.isCleared))}
        disabled={fields.header.trim() === ''} value={fields.value} onChange={(e) => set({ value: e.target.value, isCleared: false })} className={`${FIELD} max-w-56 font-mono`}
      />
      {hasValue && !fields.isCleared && (
        <Button type="button" size="sm" variant="ghost" onClick={() => set({ value: '', isCleared: true })}>{t('plugins.mcp.form.clearValue')}</Button>
      )}
    </div>
  );
}

interface ActionsProps { server?: Row; isSending: boolean; onCancel(): void; onRemove(): Promise<void> }

function FormActions({ server, isSending, onCancel, onRemove }: ActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Button type="submit" size="sm" disabled={isSending}>{t('plugins.mcp.form.save')}</Button>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t('plugins.mcp.form.cancel')}</Button>
      {server && (
        <Confirm
          title={t('plugins.mcp.remove.title')} message={t('plugins.mcp.remove.message', { name: server.name })} confirmLabel={t('plugins.mcp.remove.confirm')} onConfirm={onRemove}
          trigger={<Button type="button" size="sm" variant="outline" className="ml-auto">{t('plugins.mcp.form.remove')}</Button>}
        />
      )}
    </div>
  );
}

interface McpServerFormProps {
  server?: Row; workspaces: readonly string[];
  onSave(draft: ServerDraft): Promise<MessageKey | undefined>; onRemove(): Promise<MessageKey | undefined>; onCancel(): void;
}

/** The "+ server" panel and a server's edit (#334): inline under the table, as the view's other new-item fields. A refusal shows under the
 * fields and keeps the panel open, clearing as the user types; remove asks first, as revert does. */
export function McpServerForm({ server, workspaces, onSave, onRemove, onCancel }: McpServerFormProps) {
  const nameField = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [fields, setFields] = useState(() => fieldsOf(server));
  const [error, setError] = useState<MessageKey>();
  const [isSending, setSending] = useState(false);
  useEffect(() => {
    nameField.current?.focus(); // the panel opens to be typed in; autoFocus is refused by the lint
  }, []);
  const set: SetFields = (patch) => {
    setFields((current) => ({ ...current, ...patch }));
    setError(undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isSending) return; // a second Enter would POST the same server twice
    setSending(true);
    void onSave(draftOf(fields, server)).then((refused) => {
      setSending(false);
      setError(refused);
    });
  };
  const remove = async (): Promise<void> => setError(await onRemove());
  return (
    // the refusal may concern any field: it describes the whole form
    <form
      aria-label={server ? t('plugins.mcp.form.edit', { name: server.name }) : t('plugins.mcp.form.new')} aria-describedby={error ? errorId : undefined} onSubmit={submit} className="flex flex-col gap-2 rounded-lg border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={nameField} aria-label={t('plugins.mcp.form.name')} placeholder={t('plugins.mcp.form.name')}
          value={fields.name} onChange={(e) => set({ name: e.target.value })} className={`${FIELD} max-w-48`}
        />
        <KindSelect kind={fields.kind} onChange={(kind) => set({ kind })} />
        <ScopeSelect scope={fields.scope} workspaces={workspaces} label={t('plugins.mcp.form.scope')} onChange={(scope) => set({ scope })} />
      </div>
      {fields.kind === 'command'
        ? <Input aria-label={t('plugins.mcp.form.commandLine')} placeholder={t('plugins.mcp.form.commandLine')} value={fields.commandLine} onChange={(e) => set({ commandLine: e.target.value })} className={`${FIELD} font-mono`} />
        : <UrlFields fields={fields} hasValue={server?.hasValue === true} set={set} />}
      {error && <p id={errorId} role="alert" className="text-destructive text-xs">{t(error)}</p>}
      <FormActions server={server} isSending={isSending} onCancel={onCancel} onRemove={remove} />
    </form>
  );
}
