// JSON-RPC 2.0 over the LSP socket (#780): requests with their answers, Monaco's cancellation as $/cancelRequest, notifications handed on.
// The daemon answers every request a server makes, so the page never answers one.

export interface RpcSocket { send(data: string): void }
/** Monaco's CancellationToken, as the providers get it. */
export interface CancelToken { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export interface Rpc {
  request<T>(method: string, params: unknown, token?: CancelToken): Promise<T>;
  notify(method: string, params: unknown): void;
  receive(message: unknown): boolean; // a JSON-RPC message, taken: true; anything else (the daemon's hello): false
  fail(reason: string): void; // every request still waiting rejects
}

const REQUEST_CANCELLED = -32800;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createRpc(socket: RpcSocket, onNotification: (method: string, params: unknown) => void): Rpc {
  const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  let next = 0;
  const send = (message: object): void => socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  return {
    request<T>(method: string, params: unknown, token?: CancelToken): Promise<T> {
      const id = next;
      next += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        send({ id, method, params });
        token?.onCancellationRequested(() => {
          if (!pending.delete(id)) return;
          send({ method: '$/cancelRequest', params: { id } });
          reject(new RpcError(REQUEST_CANCELLED, 'cancelled'));
        });
      });
    },
    notify: (method, params) => send({ method, params }),
    receive(message) {
      if (!isRecord(message) || message.jsonrpc !== '2.0') return false;
      if (typeof message.method === 'string') { onNotification(message.method, message.params); return true; }
      const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (waiting === undefined) return true;
      pending.delete(message.id as number);
      if (isRecord(message.error)) waiting.reject(new RpcError(Number(message.error.code), String(message.error.message)));
      else waiting.resolve(message.result);
      return true;
    },
    fail(reason) {
      for (const waiting of pending.values()) waiting.reject(new Error(reason));
      pending.clear();
    },
  };
}
