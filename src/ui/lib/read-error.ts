import { type MessageKey, t } from '@/i18n';
import { FileError } from '@/lib/editor-models';

// The reads the panes name in their own words (#717); any other refusal shows as the server said it
const READ_ERROR: Partial<Record<number, MessageKey>> = { 404: 'editor.missing', 413: 'editor.tooLarge', 415: 'editor.binary' };

/** A refused read in the pane's own words (#717), shared by the editor, preview (#697) and image (#498) panes: 404, 413 and 415 named, any
 * other as the server said. Its own module so the image view and the editor pane, which renders it, do not import each other. */
export function messageOf(err: unknown): string {
  if (err instanceof FileError) {
    const key = READ_ERROR[err.status];
    return key === undefined ? err.message : t(key);
  }
  return err instanceof Error ? err.message : String(err);
}
