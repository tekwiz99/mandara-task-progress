// Mirrors OpenCode's real session status into Mandara's built-in `progress`
// plugin. The built-in bar chip animates at 33 ms (smooth spinner/shimmer)
// and needs no shell patch or custom Wasm plugin.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const MANDARA = process.env.MANDARA_BIN || '/home/bedevere/.local/bin/mandara';
const TASK = 'opencode';

let chain: Promise<void> = Promise.resolve();
let tracked = '';

function run(words: string[]) {
  // Always send: a task may have been removed since the identical command
  // was last issued, and `progress start` must re-create it.
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        const child = spawn(MANDARA, ['msg', ...words], { stdio: 'ignore' });
        child.on('error', () => resolve());
        child.on('close', () => resolve());
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
  try {
    appendFileSync(
      '/tmp/opencode/tp-bridge-events.log',
      `${new Date().toISOString()} ${type} ${JSON.stringify(p).slice(0, 1200)}\n`,
    );
  } catch {
    // Best effort.
  }
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
      break;
    case 'session.execution.failed':
      run(['progress', 'fail', TASK, 'Failed']);
      break;
    case 'session.execution.interrupted':
      run(['progress', 'fail', TASK, 'Interrupted']);
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
          handle(event);
        }
      } catch {
        // Server shutting down.
      }
    })();
    return () => controller.abort();
  },
  server: async () => ({}),
};
