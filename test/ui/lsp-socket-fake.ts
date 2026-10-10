// The LSP socket for jsdom (#780): what a client sent, as JSON, and the server's side played by the test.
export class FakeSocket {
  static all: FakeSocket[] = [];
  readonly url: string;
  sent: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
  isClosed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url = 'ws://hive/test') { this.url = url; FakeSocket.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.isClosed = true; }
  fromServer(message: object): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) })); }
  hello(root = '/w/root'): void { this.fromServer({ root, log: { channel: 'lsp:hive:pyright', run: 'r1' } }); }
  closeWith(code: number, reason: string): void { this.onclose?.(new CloseEvent('close', { code, reason })); }
  methods(): string[] { return this.sent.map((m) => m.method ?? `#${m.id}`); }
}

/** Answers the client's initialize with `capabilities`, once it was sent. */
export function answerInitialize(socket: FakeSocket, capabilities: object): void {
  const init = socket.sent.find((m) => m.method === 'initialize');
  if (init?.id === undefined) throw new Error('no initialize sent');
  socket.fromServer({ jsonrpc: '2.0', id: init.id, result: { capabilities } });
}
