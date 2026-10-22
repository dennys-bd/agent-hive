// The config tab's shared frame (#463, benchmark.hv.html's .sect / .rows / .note): each section draws its rows and its form through these.
import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The screen's .note: an info line in a sunken box. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-muted-foreground text-xs leading-4">
      <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />{children}
    </p>
  );
}
