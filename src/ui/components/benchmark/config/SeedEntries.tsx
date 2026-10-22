// A seed list's entries (#463): a repository path at the starting commit, or upload:<name> for a file sent to the experiment (#459).
import { UploadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { UPLOAD_PREFIX } from '../../../../benchmark/names.js';
import { FieldError, Pill } from '@/components/benchmark/config/Section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';

export interface SeedEntriesProps { label: string; experimentId: string; entries: string[]; error?: string; onChange(next: string[]): void }

const isUploadEntry = (entry: string): boolean => entry.startsWith(UPLOAD_PREFIX);
export const entryName = (entry: string): string => (isUploadEntry(entry) ? entry.slice(UPLOAD_PREFIX.length) : entry);
// The route's safeFilePath, loosely: relative, no .. segment; a folder is named without its trailing slash
const isRepoPath = (path: string): boolean => path !== '' && !path.startsWith('/') && !path.split('/').includes('..');
const pathOf = (text: string): string => text.trim().replace(/\/+$/, '');

export function EntryPill({ entry }: { entry: string }) {
  return <Pill isMono>{isUploadEntry(entry) && <UploadIcon aria-hidden="true" />}{entryName(entry)}</Pill>;
}

function PathField({ label, onAdd, onDone }: { label: string; onAdd(path: string): void; onDone(): void }) {
  const [text, setText] = useState('');
  const isValid = isRepoPath(pathOf(text));
  return (
    <span className="flex flex-col gap-1">
      <Input
        autoFocus aria-label={t('benchmark.config.seed.newPath', { field: label })} value={text} className="h-7 w-64 font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && isValid) {
            e.preventDefault();
            onAdd(pathOf(text));
          }
          if (e.key === 'Escape') onDone();
        }}
      />
      {text.trim() !== '' && !isValid && <FieldError>{t('benchmark.config.error.path')}</FieldError>}
    </span>
  );
}

/** The list's entries, each removable, plus + caminho; T7 adds + arquivo. The seed's PATCH on salvar lists them. */
export function SeedEntries({ label, entries, error, onChange }: SeedEntriesProps) {
  const [isAdding, setAdding] = useState(false);
  const add = (entry: string): void => { if (!entries.includes(entry)) onChange([...entries, entry]); };
  return (
    <span className="flex w-full flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5">
        {entries.map((entry) => (
          <span key={entry} className="inline-flex items-center">
            <EntryPill entry={entry} />
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t('benchmark.config.seed.removeEntry', { entry: entryName(entry) })} onClick={() => onChange(entries.filter((e) => e !== entry))}><XIcon /></Button>
          </span>
        ))}
        <Button type="button" variant="ghost" size="xs" onClick={() => setAdding(true)}>{t('benchmark.config.seed.addPath')}</Button>
      </span>
      {isAdding && <PathField label={label} onAdd={(path) => { add(path); setAdding(false); }} onDone={() => setAdding(false)} />}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </span>
  );
}
