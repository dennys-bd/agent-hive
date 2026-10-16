import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ItemKind } from '../../../types';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { NewItem } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN } from '@/lib/plugins';

interface NewItemFieldProps { kind: ItemKind; workspaces: readonly string[]; initialOrigin: string; onCreate(item: NewItem): Promise<MessageKey | undefined>; onCancel(): void }

/** "new skill" / "new specialist" (#313, decision 13): one name field and the target group, inline. Enter creates, Esc cancels; a refusal shows
 * its copy under the field and clears as the user types. */
export function NewItemField({ kind, workspaces, initialOrigin, onCreate, onCancel }: NewItemFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState(initialOrigin);
  const [error, setError] = useState<MessageKey>();
  const [isSending, setSending] = useState(false);
  useEffect(() => {
    input.current?.focus(); // the field opens to be typed in; autoFocus is refused by the lint
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || isSending) return; // an IME's Enter commits the text; a second Enter would answer 409
    event.preventDefault();
    setSending(true);
    void onCreate({ kind, name: name.trim(), origin }).then((refused) => {
      setSending(false);
      setError(refused);
    });
  };
  const groups = [HIVE_ORIGIN, ...workspaces.filter((w) => w !== HIVE_ORIGIN)];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          ref={input} aria-label={t(kind === 'skill' ? 'plugins.new.skillName' : 'plugins.new.specialistName')} placeholder={t('plugins.new.name')} value={name}
          aria-invalid={error !== undefined} onKeyDown={onKeyDown} onChange={(event) => { setName(event.target.value); setError(undefined); }} className="h-8 max-w-64 font-mono text-sm"
        />
        <Select value={origin} onValueChange={setOrigin}>
          <SelectTrigger size="sm" aria-label={t('plugins.new.group')}><SelectValue /></SelectTrigger>
          <SelectContent>{groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{t(error)}</p>}
    </div>
  );
}
