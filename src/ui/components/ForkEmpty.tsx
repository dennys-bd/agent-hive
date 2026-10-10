import { t } from '@/i18n';

/** A fork's empty list (#854, handoff item 8): why there is nothing here, and a link to the original in the sidebar. */
export function ForkEmpty({ text, original, onRepository }: { text: string; original?: string; onRepository?(repository: string): void }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 px-6 py-12 text-center text-[13px] text-muted-foreground">
      <p>{text}</p>
      {original !== undefined && (
        <button type="button" className="font-medium text-foreground" onClick={() => onRepository?.(original)}>{t('repos.fork.openOriginal', { original })}</button>
      )}
    </div>
  );
}
