// Copilot's transcripts (#929's contract), node 6 of #608. Its sessions live by id under the copilot home (spike §6), never per cwd, so
// transcriptDir stays undefined for good; the rest reads nothing until node 6
import type { TranscriptTurn } from '../usage.js';

export const transcriptDir = (): string | undefined => undefined;
export const ownsTranscript = (): boolean => false;
export const sessionFiles = (): Promise<string[]> => Promise.resolve([]);
export const readTurn = (): Promise<TranscriptTurn> => Promise.resolve({ tokens: 0 });
export const countMessages = (): Promise<number> => Promise.resolve(0);
