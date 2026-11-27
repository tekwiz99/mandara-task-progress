// Mirrors OpenCode activity into Mandara's built-in `progress` plugin.
//
// Three layers, no polling of raw event payloads:
//   1. Mandara's board - read back with `progress list`, reconciled on a timer
//   2. OpenCode turn   - session.execution.* / tool / permission events
//   3. OS shell processes - shell events carry pid and exit status; a liveness
//                           check on each beat catches a lost process
//
// The log at /tmp/opencode/tp-bridge-events.log records state transitions only.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const MANDARA = process.env.MANDARA_BIN || '/home/bedevere/.local/bin/mandara';
const TASK = 'opencode';
const SHELL_TASK = 'opencode-shell';
const BEAT_MS = 2 * 60_000;
const TOUCH_AFTER_MS = 4 * 60_000; // Mandara stalls at 10 min; touch well before
const TRACE = '/tmp/opencode/tp-bridge-events.log';

type ShellRec = {
  id: string;
  pid: number | undefined;
  command: string;
  status: string;
  started: number;
};

let chain: Promise<void> = Promise.resolve();
let tracked = '';
let turnPhase: 'idle' | 'running' = 'idle';
let turnLabel = 'OpenCode';
let lastTool = '';
const shells = new Map<string, ShellRec>();
let beat: ReturnType<typeof setInterval> | undefined;

function run(words: string[]) {
  // Always send: a task may have been removed since the identical command was
  // last issued, and `progress start` must re-create it.
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        const child = spawn(MANDARA, ['msg', ...words], { stdio: 'ignore' });
        child.on('error', () => resolve());
        child.on('close', () => resolve());
      }),
  );
}

// `touch` bumps updated_ms without changing status, amount or started_ms, so
// the running light keeps animating and the panel's elapsed time stays truthful.
function emit(kind: 'start' | 'touch' | 'done' | 'fail', id: string, text: string) {
  run(['progress', kind, id, text]);
}

function trace(tag: string, detail: string) {
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${tag} ${detail}\n`);
  } catch {
    // Best effort.
  }
}

function properties(event: any): any {
  return event?.data ?? event?.properties ?? event ?? {};
}

function sessionID(event: any): string {
  const p = properties(event);
  return p.sessionID ?? p.session?.id ?? '';
}

function adopt(sid: string): boolean {
  if (!sid) return true;
  if (tracked && sid !== tracked) return false;
  if (!tracked) tracked = sid;
  return true;
}

function short(text: string, max = 48): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shellLabel(): string {
  if (shells.size === 0) return 'No shell';
  if (shells.size === 1) return `Shell: ${short([...shells.values()][0].command)}`;
  return `${shells.size} shells`;
}

function readBoard(): Record<string, any> {
  try {
    const raw = execFileSync(MANDARA, ['msg', '--json', 'progress', 'list'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const reply = JSON.parse(raw);
    return Object.fromEntries((reply.data ?? []).map((t: any) => [t.id, t]));
  } catch {
    return {};
  }
}

function alive(rec: ShellRec): boolean {
  if (typeof rec.pid !== 'number' || rec.pid <= 0) return true;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== 'ESRCH';
  }
}

function ensureBeat() {
  const active = turnPhase === 'running' || shells.size > 0;
  if (active && !beat) beat = setInterval(sync, BEAT_MS);
  if (!active && beat) {
    clearInterval(beat);
    beat = undefined;
  }
}

function setTurnLabel(label: string) {
  if (turnLabel === label) return;
  turnLabel = label;
  if (turnPhase === 'running') emit('touch', TASK, turnLabel);
  trace('session', `label=${label}`);
}

function sync() {
  const board = readBoard();
  const now = Date.now();

  for (const [id, rec] of shells) {
    if (!alive(rec)) endShell(id, 'exited');
  }

  const shellTask = board[SHELL_TASK];
  if (shells.size > 0) {
    if (shellTask?.status !== 'running') {
      emit('start', SHELL_TASK, shellLabel());
      trace('board', `${SHELL_TASK} restarted`);
    } else if (now - Number(shellTask.updated_ms ?? 0) > TOUCH_AFTER_MS) {
      emit('touch', SHELL_TASK, shellLabel());
      trace('board', `${SHELL_TASK} touched`);
    }
  } else if (shellTask?.status === 'running') {
    emit('done', SHELL_TASK, 'Shells finished');
    trace('board', `${SHELL_TASK} done (no shells)`);
  }

  const task = board[TASK];
  if (turnPhase === 'running') {
    if (task?.status !== 'running') {
      emit('start', TASK, turnLabel);
      trace('board', `${TASK} restarted`);
    } else if (now - Number(task.updated_ms ?? 0) > TOUCH_AFTER_MS) {
      emit('touch', TASK, turnLabel);
      trace('board', `${TASK} touched`);
    }
  } else if (task?.status === 'running') {
    emit('done', TASK, 'All green');
    trace('board', `${TASK} done (idle)`);
  }
}

function addShell(info: any) {
  if (!info?.id) return;
  const rec: ShellRec = {
    id: String(info.id),
    pid: typeof info.pid === 'number' ? info.pid : undefined,
    command: String(info.command ?? ''),
    status: String(info.status ?? 'running'),
    started: Number(info.time?.started ?? Date.now()),
  };
  shells.set(rec.id, rec);
  const running = readBoard()[SHELL_TASK]?.status === 'running';
  emit(running ? 'touch' : 'start', SHELL_TASK, shellLabel());
  trace('process', `+${rec.id} pid=${rec.pid ?? '?'} ${short(rec.command)}`);
  ensureBeat();
}

function endShell(id: string, status: string, exit?: number) {
  const key = String(id);
  const rec = shells.get(key);
  if (!rec) return;
  if (status) rec.status = status;
  shells.delete(key);
  if (shells.size === 0) {
    const bad = rec.status === 'killed' || rec.status === 'timeout' || (typeof exit === 'number' && exit !== 0);
    emit(bad ? 'fail' : 'done', SHELL_TASK, bad ? `Shell ${rec.status}` : 'Shells finished');
  } else {
    emit('touch', SHELL_TASK, shellLabel());
  }
  trace('process', `-${key} ${rec.status}${typeof exit === 'number' ? ` exit=${exit}` : ''}`);
  ensureBeat();
}

// A reload can happen while a detached build is still running. Recover those
// processes from the server's shell registry instead of waiting for a new event.
async function recoverShells() {
  await new Promise<void>((resolve) => {
    let out = '';
    const child = spawn('opencode', ['api', 'get', '/api/shell'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 4000);
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const found = JSON.parse(out).data ?? [];
        trace('process', `recover ${found.length}`);
        for (const info of found) addShell(info);
      } catch {
        trace('process', 'recover unavailable');
      }
      resolve();
    });
  });
}

function handle(event: any) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const p = properties(event);
  if (!adopt(sessionID(event))) return;

  switch (type) {
    case 'session.execution.started':
      turnPhase = 'running';
      turnLabel = 'OpenCode';
      emit('start', TASK, turnLabel);
      trace('session', 'started');
      ensureBeat();
      break;
    case 'session.execution.succeeded':
      turnPhase = 'idle';
      emit('done', TASK, 'All green');
      trace('session', 'succeeded');
      ensureBeat();
      break;
    case 'session.execution.failed':
      turnPhase = 'idle';
      emit('fail', TASK, 'Failed');
      trace('session', 'failed');
      ensureBeat();
      break;
    case 'session.execution.interrupted':
      turnPhase = 'idle';
      emit('fail', TASK, 'Interrupted');
      trace('session', 'interrupted');
      ensureBeat();
      break;
    case 'permission.asked':
    case 'form.created':
      setTurnLabel('Needs confirmation');
      break;
    case 'permission.replied':
    case 'permission.rejected':
    case 'form.replied':
    case 'form.cancelled':
      setTurnLabel('OpenCode');
      break;
    case 'session.tool.input.started': {
      const name = String(p.name ?? p.tool ?? '');
      if (name && name !== lastTool) {
        lastTool = name;
        trace('tool', lastTool);
      }
      break;
    }
    case 'session.tool.failed':
      setTurnLabel('Tool failed');
      emit('fail', TASK, 'Tool failed');
      break;
    case 'session.tool.success':
      setTurnLabel('OpenCode');
      break;
    case 'session.shell.started':
    case 'shell.created':
      addShell(p.shell ?? p.info);
      break;
    case 'shell.exited':
      endShell(p.id, p.status ?? 'exited', typeof p.exit === 'number' ? p.exit : undefined);
      break;
    case 'shell.deleted':
      endShell(p.id, 'exited');
      break;
    default:
      break;
  }
}

export default {
  id: 'task-progress-bridge',
  async setup(ctx: any) {
    const controller = new AbortController();

    // A reload can land mid-turn: recover the session from the board and the
    // process layer from the server's shell registry.
    const board = readBoard();
    if (board[TASK]?.status === 'running') {
      turnPhase = 'running';
      turnLabel = String(board[TASK].label ?? 'OpenCode');
    }
    await recoverShells();
    ensureBeat();

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handle(event);
        }
      } catch {
        // Server shutting down.
      }
    })();

    return () => {
      controller.abort();
      if (beat) clearInterval(beat);
      beat = undefined;
    };
  },
  server: async () => ({}),
};
