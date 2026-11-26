// Mirrors OpenCode's real session status into Mandara's built-in `progress`
// plugin. The built-in bar chip animates at 33 ms (smooth breathing light)
// and needs no shell patch or custom Wasm plugin.
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

const MANDARA = process.env.MANDARA_BIN || '/home/bedevere/.local/bin/mandara';
const TASK = 'opencode';
const TRACE = process.env.TASK_PROGRESS_TRACE === '1';
const TRACE_LOG = '/tmp/opencode/tp-bridge-events.log';
// Keep re-sending an identical command (a task may have been removed since),
// but coalesce bursts from events that describe the same change, such as
// `permission.asked` followed by `form.created`.
const DEDUPE_MS = 250;

let chain: Promise<void> = Promise.resolve();
let tracked = '';
let disposed = false;
const lastSent = new Map<string, number>();
let traceChain: Promise<void> = Promise.resolve();

function run(words: string[]) {
  if (disposed) return;
  const key = words.join(' ');
  const now = Date.now();
  if (now - (lastSent.get(key) ?? -Infinity) < DEDUPE_MS) return;
  lastSent.set(key, now);
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        if (disposed) return resolve();
        const child = spawn(MANDARA, ['msg', ...words], { stdio: 'ignore' });
        child.on('error', (error) => {
          if (TRACE) console.error(`task-progress-bridge: ${error.message}`);
          resolve();
        });
        child.on('close', (code) => {
          if (TRACE && code !== 0) console.error(`task-progress-bridge: ${key} exited ${code}`);
          resolve();
        });
      }),
  );
}

function properties(event: any): any {
  return event?.data ?? event?.properties ?? event ?? {};
}

function sessionID(event: any): string {
  const p = properties(event);
  return p.sessionID ?? p.session?.id ?? '';
}

function isAsk(p: any): boolean {
  const name = p.tool ?? p.toolName ?? p.name ?? p.part?.tool ?? p.part?.name ?? '';
  return /question|ask|form|permission|confirm|clarif/i.test(String(name));
}

function trace(type: string, p: any) {
  if (!TRACE) return;
  const line = `${new Date().toISOString()} ${type} ${JSON.stringify(p).slice(0, 1200)}\n`;
  // Async and serialised: logging must never block OpenCode's event loop.
  traceChain = traceChain.then(() => appendFile(TRACE_LOG, line).catch(() => {}));
}

function handle(event: any) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const p = properties(event);
  const sid = sessionID(event);

  if (sid && tracked && sid !== tracked) return;
  if (sid && !tracked) tracked = sid;

  if (/permission|form|question|session\.execution/i.test(type) || isAsk(p)) trace(type, p);

  switch (type) {
    case 'session.execution.started':
      run(['progress', 'start', TASK, 'OpenCode']);
      break;
    case 'permission.asked':
    case 'form.created':
      run(['progress', 'start', TASK, 'Needs confirmation']);
      break;
    case 'permission.replied':
    case 'permission.rejected':
    case 'form.replied':
    case 'form.cancelled':
      run(['progress', 'start', TASK, 'OpenCode']);
      break;
    case 'session.execution.succeeded':
      run(['progress', 'done', TASK, 'All green']);
      tracked = '';
      break;
    case 'session.execution.failed':
      run(['progress', 'fail', TASK, 'Failed']);
      tracked = '';
      break;
    case 'session.execution.interrupted':
      run(['progress', 'fail', TASK, 'Interrupted']);
      tracked = '';
      break;
    case 'session.tool.failed':
      run(['progress', 'fail', TASK, 'Tool failed']);
      break;
    default:
      break;
  }
}

export default {
  id: 'task-progress-bridge',
  setup(ctx: any) {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!disposed) handle(event);
        }
      } catch {
        // Server shutting down.
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  },
  server: async () => ({}),
};
