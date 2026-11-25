import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

interface HostChipsProps {
  hosts: string[];
  onChange(hosts: string[]): void;
  /** The list with the typed host, by the card's rule; undefined when the rule refuses it. */
  add(hosts: readonly string[], text: string): string[] | undefined;
  addLabel: string;
  removeLabel(host: string): string;
  error(host: string): string;
}

// A card's host chips (#404, #513, #1044): a host per Badge, an input that adds one on Enter or on blur. A refused host stays in the input with
// the error under it, so a typed host is never lost silently. Each card brings its own rule and words.
export function HostChips({ hosts, onChange, add, addLabel, removeLabel, error }: HostChipsProps) {
  const [text, setText] = useState('');
  const [isBad, setBad] = useState(false);

  function commit(): void {
    const next = add(hosts, text);
    if (!next) { setBad(true); return; }
    setText('');
    setBad(false);
    if (next.length !== hosts.length) onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  }

  function onBlur(): void {
    if (text.trim() !== '') commit();
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {hosts.map((host) => (
          <Badge key={host} variant="secondary">
            {host}
            <button type="button" aria-label={removeLabel(host)} onClick={() => onChange(hosts.filter((h) => h !== host))}>
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          className="w-60" aria-label={addLabel} placeholder={addLabel} aria-invalid={isBad}
          value={text} onChange={(e) => { setText(e.target.value); setBad(false); }} onKeyDown={onKeyDown} onBlur={onBlur}
        />
      </div>
      {isBad && <p className="text-destructive text-xs">{error(text.trim().toLowerCase())}</p>}
    </>
  );
}
