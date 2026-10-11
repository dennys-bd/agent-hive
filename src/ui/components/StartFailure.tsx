import { useState } from 'react';
import { startFailureRaw, taskError } from '@/components/CommandsProgress';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

// A failed start in the details panel (#945): the short message in the viewer's language first, the spawn's raw text (a path, git's
// porcelain lines) only behind details, for debugging. Closed whenever the panel mounts: nothing is persisted
export function StartFailure({ error }: { error: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div role="alert" className="flex flex-col gap-1.5 text-xs">
      <p className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 break-words text-destructive">{taskError(error)}</span>
        <Button
          type="button" variant="ghost" size="xs" aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}
          className="h-auto shrink-0 px-1.5 py-0.5 font-normal text-muted-foreground text-xs"
        >
          {t('start.failed.details')}
        </Button>
      </p>
      {isOpen && <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-muted-foreground">{startFailureRaw(error)}</p>}
    </div>
  );
}
