// The diagram pane's talk with draw.io (#956): messages taken from its own frame's window only, the file read and loaded on init, a pending
// diagram laid out once, every autosave written with one PUT in flight, and the disk followed while the pane shows, as the editor's (#717).
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { FileSaved } from '../../types';
import type { Strip } from '@/components/EditorPane';
import { type DiskVersion, useFileVersion } from '@/hooks/use-file-version';
import { gated, WriteCancelled } from '@/lib/api';
import { type DrawioFile, loadMessage, parseDrawioFile, ROUTE_EDGES } from '@/lib/drawio-file';
import { activityRoute, readFile } from '@/lib/file-read';
import { messageOf } from '@/lib/read-error';

const HTTP_CONFLICT = 409;

/** What draw.io posts (#956): its event and, on load and autosave, the diagram's XML. */
export interface DrawioEvent { event: string; xml?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The frame's message, or undefined for any other: every sandboxed sender's origin is "null", so the frame's own window is the only check;
 *  its data must be a JSON string of an object with a string event. */
export function drawioEvent(message: MessageEvent, frame: HTMLIFrameElement | null): DrawioEvent | undefined {
  if (frame === null || message.source !== frame.contentWindow || typeof message.data !== 'string') return undefined;
  try {
    const data: unknown = JSON.parse(message.data);
    if (!isRecord(data) || typeof data.event !== 'string') return undefined;
    return typeof data.xml === 'string' ? { event: data.event, xml: data.xml } : { event: data.event };
  } catch {
    return undefined; // not JSON: nothing draw.io wrote
  }
}

// '*': the frame's origin is opaque, so no named origin matches it; the message goes to this frame's window alone (design-frame.tsx does the same)
const post = (frame: HTMLIFrameElement | null, message: object): void => { frame?.contentWindow?.postMessage(JSON.stringify(message), '*'); };

type WriteResult = { status: 'saved'; version: string } | { status: 'conflict'; version: string } | { status: 'error'; message: string } | { status: 'cancelled' };

// fetch, not sendJson, so a 409 keeps its version, as editor-models' put; behind run mode's gate (#469). format false: draw.io's XML is canonical
function putDiagram(activityId: string, path: string, xml: string, version: string): Promise<WriteResult> {
  const route = activityRoute(activityId, 'file');
  return gated(route, async (): Promise<WriteResult> => {
    const res = await fetch(route, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ path, text: xml, version, format: false }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FileSaved> & { error?: string };
    if (res.status === HTTP_CONFLICT && body.version !== undefined) return { status: 'conflict', version: body.version };
    if (!res.ok || body.version === undefined) return { status: 'error', message: body.error ?? res.statusText };
    return { status: 'saved', version: body.version };
  }).catch((err: unknown): WriteResult => (err instanceof WriteCancelled ? { status: 'cancelled' } : { status: 'error', message: messageOf(err) }));
}

// version: the disk's version the frame shows; queued: the newest autosave not yet sent; isPaused: the strip is up, or the file is gone
interface WriterState { version?: string; queued?: string; isFlying: boolean; isPaused: boolean }
interface DiagramWriter { strip?: Strip; error?: string; write(xml: string): void; opened(version: string): void; reload(): void; keep(version: string): void }

// One PUT in flight: an autosave meanwhile replaces the queued XML, so a burst of edits costs one write per round trip
function useDiagramWriter(activityId: string, path: string, active: boolean, reopen: () => void): DiagramWriter {
  const state = useRef<WriterState>({ isFlying: false, isPaused: false });
  const [strip, setStrip] = useState<Strip>();
  const [error, setError] = useState<string>();
  const change = (next: Partial<WriterState>): void => { state.current = { ...state.current, ...next }; };
  const landed = (sent: string, result: WriteResult): void => {
    change({ isFlying: false });
    if (result.status === 'saved') {
      change({ version: result.version });
      setError(undefined);
      flush();
      return;
    }
    change({ queued: state.current.queued ?? sent }); // a newer autosave wins; else this XML waits for the next try
    if (result.status === 'conflict') {
      change({ isPaused: true });
      setStrip({ kind: 'changed', version: result.version });
    } else if (result.status === 'error') setError(result.message); // the next autosave tries again
  };
  const flush = (): void => {
    const { version, queued, isFlying, isPaused } = state.current;
    if (isFlying || isPaused || queued === undefined || version === undefined) return;
    change({ queued: undefined, isFlying: true });
    void putDiagram(activityId, path, queued, version).then((result) => landed(queued, result));
  };
  useDiskFollow(activityId, path, active, { state, change, strip, setStrip, reopen });
  return {
    strip, error,
    write: (xml) => { change({ queued: xml }); flush(); },
    opened: (version) => { change({ version, queued: undefined, isPaused: false }); setStrip(undefined); setError(undefined); },
    reload: () => { change({ queued: undefined, isPaused: false }); setStrip(undefined); reopen(); },
    keep: (version) => { change({ version, isPaused: false }); setStrip(undefined); flush(); },
  };
}

interface Follow { state: RefObject<WriterState>; change(next: Partial<WriterState>): void; strip?: Strip; setStrip(strip: Strip | undefined): void; reopen(): void }

// The disk against the pane, polled while it shows: a clean pane loads the disk's version, one with a queued write raises the strip.
// A PUT in flight ignores the poll: its own write may land before its answer, and another writer's answers it 409 anyway
function useDiskFollow(activityId: string, path: string, active: boolean, { state, change, strip, setStrip, reopen }: Follow): void {
  useFileVersion(activityId, path, active, (disk: DiskVersion) => {
    const { version, queued, isFlying, isPaused } = state.current;
    if (isFlying || version === undefined) return;
    if (disk === null) {
      change({ isPaused: true });
      setStrip({ kind: 'missing' });
    } else if (disk === version) {
      if (strip?.kind === 'missing') { change({ isPaused: false }); setStrip(undefined); }
    } else if (queued !== undefined || isPaused) {
      change({ isPaused: true });
      setStrip({ kind: 'changed', version: disk });
    } else reopen();
  });
}

export interface DiagramBridge { frame: RefObject<HTMLIFrameElement | null>; error?: string; strip?: Strip; reload(): void; keep(version: string): void }

/** The pane's frame and its protocol (#956): init reads the file and loads it, a preset's load asks libavoid for the edges, a Mermaid load's
 *  XML and every autosave are written. */
export function useDiagramBridge(activityId: string, path: string, active: boolean): DiagramBridge {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<DrawioFile['kind'] | undefined>(undefined); // what the next load event finishes
  const [readError, setReadError] = useState<string>();
  const writer = useDiagramWriter(activityId, path, active, () => open());
  const open = (): void => {
    readFile(activityId, path).then((file) => {
      const parsed = parseDrawioFile(file.text);
      pending.current = parsed.kind;
      writer.opened(file.version);
      setReadError(undefined);
      post(frame.current, loadMessage(parsed));
    }, (err: unknown) => setReadError(messageOf(err)));
  };
  const loaded = (xml?: string): void => {
    const kind = pending.current;
    pending.current = undefined;
    if (kind === 'layout') post(frame.current, ROUTE_EDGES);
    else if (kind === 'mermaid' && xml !== undefined) writer.write(xml);
  };
  const onEvent = (message: DrawioEvent): void => {
    if (message.event === 'init') open();
    else if (message.event === 'load') loaded(message.xml);
    else if (message.event === 'autosave' && message.xml !== undefined) writer.write(message.xml);
  };
  const latest = useRef(onEvent);
  useEffect(() => { latest.current = onEvent; });
  useEffect(() => {
    const listen = (message: MessageEvent): void => {
      const event = drawioEvent(message, frame.current);
      if (event !== undefined) latest.current(event);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  return { frame, error: readError ?? writer.error, strip: writer.strip, reload: writer.reload, keep: writer.keep };
}
