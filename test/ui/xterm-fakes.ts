interface FakeLink { text: string; activate(): void }
/** What linkFiles registers (#258): a test calls provideLinks with a 1-based row and activates the links it answers. */
export interface FakeLinkProvider { provideLinks(y: number, callback: (links: FakeLink[] | undefined) => void): void }

// Stand-ins for xterm and WebSocket (#251, #407): jsdom has no canvas, and its WebSocket would dial a real host. A test mocks '@xterm/xterm'
// and '@xterm/addon-fit' (and '@xterm/addon-search', #12) with these classes, stubs WebSocket with FakeWebSocket, and drives the output, the keys and the close by hand.
export class FakeTerminal {
  static all: FakeTerminal[] = [];
  options: Record<string, unknown> = {};
  written: string[] = [];
  disposed = false;
  cols = 120;
  rows = 30;
  lines: string[] = []; // the screen's rows as text, read by a link provider through the buffer (#400)
  providers: FakeLinkProvider[] = [];
  textarea: HTMLTextAreaElement | undefined = document.createElement('textarea'); // xterm's hidden input, there once open() ran: the key probe listens on it (#732)
  selection = ''; // #12: what hasSelection / getSelection answer, '' for none
  parser = { registerOscHandler: () => ({ dispose() {} }) }; // terminalClipboard's OSC 52 (#543)
  private keyHandler: (event: KeyboardEvent) => boolean = () => true; // terminalKeys' handler (#448); press() drives it
  buffer = { active: { getLine: (y: number) => (this.lines[y] === undefined ? undefined : { translateToString: () => this.lines[y] }) } };
  private typed: ((data: string) => void)[] = [];
  private sized: ((size: { cols: number; rows: number }) => void)[] = [];
  private parsing: (() => void)[] = []; // #831: callbacks of writes xterm has not parsed yet
  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options }; // what new Terminal was given (#404: the link handler), then whatever the code sets later
    FakeTerminal.all.push(this);
  }
  loadAddon(): void {}
  open(): void {}
  focus(): void {}
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  press(init: KeyboardEventInit): boolean { // a keydown as xterm hands it to the custom handler; false: refused to xterm
    return this.keyHandler(new KeyboardEvent('keydown', { cancelable: true, ...init }));
  }
  hasSelection(): boolean {
    return this.selection !== '';
  }
  getSelection(): string {
    return this.selection;
  }
  registerLinkProvider(provider: FakeLinkProvider): { dispose(): void } {
    this.providers.push(provider);
    return { dispose: () => {} };
  }
  write(data: string, callback?: () => void): void { // xterm parses a write later; its callback waits for parse() (#831)
    this.written.push(data);
    if (callback) this.parsing.push(callback);
  }
  parse(): void { // xterm has parsed every write so far: their callbacks run, in order
    const done = this.parsing;
    this.parsing = [];
    for (const callback of done) callback();
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.typed.push(listener);
    return { dispose: () => {} };
  }
  dispose(): void {
    this.disposed = true;
  }
  type(data: string): void {
    for (const listener of this.typed) listener(data);
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.sized.push(listener);
    return { dispose: () => {} };
  }
  resize(cols: number, rows: number): void { // xterm's own resize, as a fit calls it: the grid changes and onResize fires
    this.cols = cols;
    this.rows = rows;
    for (const listener of this.sized) listener({ cols, rows });
  }
}

export class FakeFitAddon {
  fit(): void {}
}

type FakeResults = { resultIndex: number; resultCount: number };

/** The search addon (#12): it records each search and clear, and a test fires its results by hand. */
export class FakeSearchAddon {
  static all: FakeSearchAddon[] = [];
  readonly options: unknown;
  calls: [string, string, boolean | undefined][] = []; // [next | previous, term, incremental]
  cleared = 0;
  private listeners: ((results: FakeResults) => void)[] = [];
  constructor(options?: unknown) {
    this.options = options;
    FakeSearchAddon.all.push(this);
  }
  findNext(term: string, options?: { incremental?: boolean }): boolean {
    this.calls.push(['next', term, options?.incremental]);
    return true;
  }
  findPrevious(term: string, options?: { incremental?: boolean }): boolean {
    this.calls.push(['previous', term, options?.incremental]);
    return true;
  }
  clearDecorations(): void {
    this.cleared += 1;
  }
  onDidChangeResults(listener: (results: FakeResults) => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  }
  results(resultIndex: number, resultCount: number): void {
    for (const listener of this.listeners) listener({ resultIndex, resultCount });
  }
}

export class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readonly url: string;
  sent: string[] = [];
  closed = false; // the page closed it
  private state: 'connecting' | 'open' | 'closed' = 'connecting';
  private listeners = new Map<string, ((event: Event) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }
  get path(): string { // the url without the page's own host, which jsdom picks
    return new URL(this.url).pathname;
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    if (this.state === 'connecting') throw new Error('InvalidStateError: still connecting'); // what a browser does before open
    if (this.state === 'open') this.sent.push(data); // a closed socket drops it, as a browser does
  }
  close(): void { // a browser reports the page's own close as a close event too; synchronous here so a teardown that forgets it shows
    this.closed = true;
    this.end();
  }
  open(): void {
    this.state = 'open';
    this.fire(new Event('open'));
  }
  receive(data: string): void {
    this.fire(new MessageEvent('message', { data }));
  }
  end(): void { // the server closed or refused it: the pty exited, a 404 / 409 / 403, the daemon gone
    this.state = 'closed';
    this.fire(new Event('close'));
  }
  private fire(event: Event): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

export function resetFakes(): void {
  FakeTerminal.all.length = 0;
  FakeSearchAddon.all.length = 0;
  FakeWebSocket.all.length = 0;
}
