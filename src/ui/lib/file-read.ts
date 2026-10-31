// The editor's reads from the disk (#717, #498): a file's text and version, an image's bytes, and the routes they go through. Out of
// editor-models.ts (#551), which re-exports them, to keep that file under its size.
import type { FileText } from '../../types';

/** A read the pane cannot show (#717): the route's status, which the pane names in its own words, and the server's message. */
export class FileError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Route = 'file' | 'file-version' | 'image';
export const activityRoute = (activityId: string, name: Route): string => `/activities/${encodeURIComponent(activityId)}/${name}`;

/** A file's read, version or image route (#717, #498), the path in the query. */
export const fileUrl = (activityId: string, path: string, name: Route = 'file'): string =>
  `${activityRoute(activityId, name)}?${new URLSearchParams({ path })}`;

// A refused read (#717): the route's status and the server's words, its status text when the body has none
async function refusal(res: Response): Promise<FileError> {
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  return new FileError(res.status, error ?? res.statusText);
}

/** A file's text and version from the disk (#717); a refused read rejects with a FileError. The preview pane reads through it too (#697). */
export async function readFile(activityId: string, path: string): Promise<FileText> {
  const res = await fetch(fileUrl(activityId, path));
  if (res.ok) return (await res.json()) as FileText;
  throw await refusal(res);
}

/** An image's bytes from the disk (#498), for the image view's object URL; a refused read rejects with a FileError. */
export async function readImage(activityId: string, path: string): Promise<Blob> {
  const res = await fetch(fileUrl(activityId, path, 'image'));
  if (res.ok) return res.blob();
  throw await refusal(res);
}
