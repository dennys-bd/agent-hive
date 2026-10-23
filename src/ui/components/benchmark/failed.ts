// A refused benchmark post's status as the copy the screen shows (root design, Routes): the route logs a 500's detail, its words never reach
// the screen. The shell's toasts and the sleep dialogs' inline errors (#468) read this one map.
import { statusOf } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';

const FAILED: Readonly<Record<number, MessageKey>> = { 400: 'benchmark.header.failed.invalid', 404: 'benchmark.header.failed.gone', 409: 'benchmark.header.failed.running' };

export const failedText = (err: unknown): string => t(FAILED[statusOf(err)] ?? 'benchmark.header.failed.unknown');
