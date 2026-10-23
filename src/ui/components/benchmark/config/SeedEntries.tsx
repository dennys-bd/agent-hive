// A seed list's entries (#463): a repository path at the starting commit, or upload:<name> for a file sent to the experiment (#459).
import { UploadIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { UPLOAD_NAME, UPLOAD_PREFIX } from '../../../../benchmark/names.js';
import { refusalOf, toastRefusal, uploadSeedFile } from '@/components/benchmark/config/save-section';
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

// The browser hands the file as a data URL; the route wants the bare base64 after its comma
const base64Of = (file: File): Promise<string> => new Promise((done, fail) => {
  const reader = new FileReader();
  reader.onload = () => done(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => fail(reader.error);
  reader.readAsDataURL(file);
});

interface UploadProps { label: string; experimentId: string; onUploaded(name: string): void; onError(text: string | undefined): void }

// Sent when picked (spec, "Reference and sample files"); a name in a seed that has run is the route's 409, said here, not as a toast
function UploadButton({ label, experimentId, onUploaded, onError }: UploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    if (!UPLOAD_NAME.test(file.name)) return onError(t('benchmark.config.error.uploadName'));
    try {
      await uploadSeedFile(experimentId, file.name, await base64Of(file));
      onError(undefined);
      onUploaded(file.name);
    } catch (err) {
      if (refusalOf(err).error === 'seed_locked') onError(t('benchmark.config.seed.uploadLocked', { name: file.name }));
      else toastRefusal(err);
    }
  };
  return (
    <>
      <Button type="button" variant="ghost" size="xs" onClick={() => input.current?.click()}>{t('benchmark.config.seed.addFile')}</Button>
      <input
        ref={input} type="file" aria-label={t('benchmark.config.seed.uploadTo', { field: label })} className="sr-only"
        onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} // cleared, so the same file can be picked again after a refusal
      />
    </>
  );
}

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

/** The list's entries, each removable, plus + caminho and + arquivo. The seed's PATCH on salvar lists them. */
export function SeedEntries({ label, experimentId, entries, error, onChange }: SeedEntriesProps) {
  const [isAdding, setAdding] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
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
        <UploadButton label={label} experimentId={experimentId} onUploaded={(name) => add(`${UPLOAD_PREFIX}${name}`)} onError={setUploadError} />
      </span>
      {isAdding && <PathField label={label} onAdd={(path) => { add(path); setAdding(false); }} onDone={() => setAdding(false)} />}
      {(uploadError ?? error) !== undefined && <FieldError>{uploadError ?? error}</FieldError>}
    </span>
  );
}
