import type { KeyboardEvent } from 'react';
import { MentionField } from '@/components/MentionField';
import { useReviewSurface } from '@/components/review-surface';
import { Textarea } from '@/components/ui/textarea';

interface ReviewFieldProps {
  label: string; value: string; chips: string[]; participants?: string[]; autoFocus?: boolean;
  onChange(value: string, chips: string[]): void; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
}

/** A comment's or a reply's field (#591, #592): with sessions, the mention field and its chips; on GitHub, plain text. */
export function ReviewField({ label, value, chips, participants, autoFocus, onChange, onKeyDown }: ReviewFieldProps) {
  const surface = useReviewSurface();
  if (surface.sessions !== undefined) {
    return <MentionField label={label} value={value} chips={chips} participants={participants} autoFocus={autoFocus} onChange={onChange} onKeyDown={onKeyDown} />;
  }
  return (
    <Textarea
      autoFocus={autoFocus}
      aria-label={label} placeholder={label} value={value} className="min-h-16 text-[13px]"
      onChange={(event) => onChange(event.target.value, [])} onKeyDown={onKeyDown}
    />
  );
}
