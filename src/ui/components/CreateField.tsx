import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

/** A create-task dialog field (#771, #772): its label with an optional muted note (opcional, no project), the control, and a hint under it. */
export function CreateField({ id, label, note, hint, children }: { id: string; label: string; note?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="font-normal text-[13px] text-muted-foreground">
        {label}{note !== undefined && <small className="text-xs"> · {note}</small>}
      </Label>
      {children}
      {hint !== undefined && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}
