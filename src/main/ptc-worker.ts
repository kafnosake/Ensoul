import { parentPort, workerData } from 'worker_threads';

const port = parentPort!;
let seq = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const issued: Promise<unknown>[] = [];
port.on('message', (message) => {
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.error) call.reject(new Error(message.error));
  else call.resolve(message.value);
});

const tools = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return (args: unknown = {}) => {
      const id = ++seq;
      const call = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ type: 'call', id, name, args });
      });
      issued.push(call);
      void call.catch(() => {});
      return call;
    };
  },
});
const logs: string[] = [];
/** 攒到这里就停手，收尾时统一留头留尾（从前一超过 20000 就整条不再收，尾巴上的报错全丢） */
const LOGS_CAP = 200_000;
const format = (value: unknown) => typeof value === 'object' ? JSON.stringify(value) : String(value);
const output = (...values: unknown[]) => {
  if (logs.join('\n').length >= LOGS_CAP) return;
  logs.push(values.map(format).join(' ').slice(0, 20_000));
};
const consoleProxy = { log: output, warn: output, error: output };

void (async () => {
  let value: unknown;
  let error = '';
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    value = await new AsyncFunction('tools', 'console', workerData.code)(tools, consoleProxy);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await Promise.allSettled(issued);
  port.postMessage({ type: 'done', value, error, logs });
})().catch((err) => port.postMessage({ type: 'done', error: String(err), logs }));
