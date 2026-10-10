// Every C0 and C1 control but tab and newline (#483): the text may be typed into a live pty, where an ESC could close its bracketed paste
// and send the rest as keystrokes. CR goes to LF first, so a pasted CRLF keeps its line break.
const CONTROLS = /(?![\t\n])\p{Cc}/gu;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const SUBMIT = '\r';

/** Text safe to type into a pty (#483, #591): CR/CRLF as LF, no control but tab and newline. */
export const withoutControls = (text: string): string => text.replace(/\r\n?/g, '\n').replace(CONTROLS, '');

/** A bracketed paste (#483): the terminal hands the text over as one paste, so its newlines never submit it early; the \r after it submits
 * it, or queues it while the agent works. The caller passes clean text (withoutControls). */
export const bracketedPaste = (text: string): string => `${PASTE_START}${text}${PASTE_END}${SUBMIT}`;
