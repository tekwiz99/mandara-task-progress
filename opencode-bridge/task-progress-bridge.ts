// Mirrors OpenCode activity into Mandara's built-in `progress` plugin.
//
// Three layers, no polling of raw event payloads:
//   1. Mandara's board - read back with `progress list`, reconciled on a timer
//   2. OpenCode turn   - session.execution.* / tool / permission events
//   3. OS shell processes - shell events carry pid and exit status; a liveness
//                           check on each beat catches a lost process
//
// The plugin instance is server-wide, so its event stream sees every session.
// It follows whichever sessions are actually running (confirmed against
// /api/session/active on each beat) instead of pinning to the first session ID
// it ever saw. Pending questions and permission requests are part of a turn and
// are recovered from /api/form and /api/permission/request; they use Mandara's
// `progress wait` state so the light holds steady instead of breathing. The log
// at /tmp/opencode/tp-bridge-events.log records state transitions only.
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
let activeSessions = new Set<string>();
let awaitingDecision = false;
let turnPhase: 'idle' | 'running' = 'idle';
let turnLabel = 'OpenCode';
let lastTool = '';
const shells = new Map<string, ShellRec>();
let beat: ReturnType<typeof setInterval> | undefined;
let syncing = false;

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
function emit(kind: 'start' | 'wait' | 'touch' | 'done' | 'fail', id: string, text: string) {
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

// Follow the session that just started, and accept events from any session the
// server reports as running. Events with no sessionID (shells, forms) are global.
function adopt(sid: string, started: boolean): boolean {
  if (!sid) return true;
  if (started) {
    tracked = sid;
    return true;
  }
  if (tracked && sid !== tracked && !activeSessions.has(sid)) return false;
  if (!tracked) tracked = sid;
  return true;
}

function isRunning(): boolean {
  return activeSessions.size > 0 || awaitingDecision;
}

function setActive(sid: string, on: boolean) {
  if (on) activeSessions.add(sid);
  else activeSessions.delete(sid);

  if (isRunning() && turnPhase !== 'running') {
    turnPhase = 'running';
    if (!activeSessions.has(tracked) && activeSessions.size > 0) tracked = [...activeSessions][0];
    trace('session', 'running from events');
  } else if (!isRunning() && turnPhase === 'running') {
    turnPhase = 'idle';
  }
}

function setDecision(pending: boolean) {
  if (awaitingDecision === pending) return;
  awaitingDecision = pending;
  if (pending && turnPhase !== 'running') {
    turnPhase = 'running';
    trace('session', 'running from decision');
  } else if (!pending && !isRunning() && turnPhase === 'running') {
    turnPhase = 'idle';
  }
  turnLabel = pending ? 'Needs confirmation' : 'OpenCode';
  trace('session', pending ? 'decision pending' : 'decision resolved');
  trace('session', `label=${turnLabel}`);
  // `wait` holds the board light steady; the next `touch` resumes the same
  // task with its elapsed time and value intact.
  if (pending) emit('wait', TASK, turnLabel);
  else if (isRunning()) emit('touch', TASK, turnLabel);
  else emit('done', TASK, 'All green');
  ensureBeat();
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

function apiGet(path: string): Promise<any | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('opencode', ['api', 'get', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 4000);
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Durable server-side truth for sync: a missed or reordered `execution.started`
// must not leave the board stuck on `done` for the previous session.
async function readActiveSessions(): Promise<string[] | undefined> {
  const reply = await apiGet('/api/session/active');
  const data = reply?.data ?? reply;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return Object.keys(data).filter((id) => (data[id] as any)?.type === 'running');
}

// A pending question form or permission request is part of the turn: the agent
// is blocked on the user, not finished. Recover these on every beat so a
// decision left over from before a reload still shows on the board.
async function readPendingDecisions(): Promise<boolean> {
  const [forms, perms] = await Promise.all([apiGet('/api/form'), apiGet('/api/permission/request')]);
  const f = forms?.data ?? forms;
  const p = perms?.data ?? perms;
  return (Array.isArray(f) && f.length > 0) || (Array.isArray(p) && p.length > 0);
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
  if (active && !beat) beat = setInterval(() => void sync(), BEAT_MS);
  if (!active && beat) {
    clearInterval(beat);
    beat = undefined;
  }
}

function setTurnLabel(label: string) {
  if (turnLabel === label) return;
  turnLabel = label;
  // While a decision is pending the board label is owned by `wait`; a touch
  // here would resume the task before the user has answered.
  if (turnPhase === 'running' && !awaitingDecision) emit('touch', TASK, turnLabel);
  trace('session', `label=${label}`);
}

// Reconcile the board from the current phase. Called on every event-driven
// transition and on each beat after the active-session check.
function reconcileBoard() {
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
  if (awaitingDecision) {
    if (task?.status !== 'waiting' || now - Number(task.updated_ms ?? 0) > TOUCH_AFTER_MS) {
      emit('wait', TASK, turnLabel);
      trace('board', `${TASK} waiting refreshed`);
    }
  } else if (task?.status === 'waiting') {
    if (turnPhase === 'running') emit('touch', TASK, turnLabel);
    else emit('done', TASK, 'All green');
    trace('board', `${TASK} resumed from waiting`);
  } else if (turnPhase === 'running') {
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

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const [live, pending] = await Promise.all([readActiveSessions(), readPendingDecisions()]);
    if (live !== undefined) {
      activeSessions = new Set(live);
      if (activeSessions.size > 0 && !activeSessions.has(tracked)) tracked = [...activeSessions][0];
    }
    setDecision(pending);
    if (isRunning() && turnPhase !== 'running') {
      turnPhase = 'running';
      trace('session', `running from server (${[...activeSessions].join(', ') || 'decision'})`);
    } else if (!isRunning() && turnPhase === 'running') {
      turnPhase = 'idle';
      trace('session', 'idle from server');
    }
    setTurnLabel(pending ? 'Needs confirmation' : 'OpenCode');
    reconcileBoard();
  } finally {
    syncing = false;
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
  const found = (await apiGet('/api/shell'))?.data ?? [];
  trace('process', `recover ${found.length}`);
  for (const info of found) addShell(info);
}

function handle(event: any) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const p = properties(event);
  if (!adopt(sessionID(event), type === 'session.execution.started')) return;

  switch (type) {
    case 'session.execution.started': {
      const sid = sessionID(event);
      if (sid) setActive(sid, true);
      setTurnLabel(awaitingDecision ? 'Needs confirmation' : 'OpenCode');
      emit('start', TASK, turnLabel);
      trace('session', `started ${sid}`);
      ensureBeat();
      break;
    }
    case 'session.execution.succeeded': {
      const sid = sessionID(event);
      if (sid) setActive(sid, false);
      if (!isRunning()) emit('done', TASK, 'All green');
      trace('session', `succeeded ${sid}`);
      ensureBeat();
      break;
    }
    case 'session.execution.failed': {
      const sid = sessionID(event);
      if (sid) setActive(sid, false);
      if (!isRunning()) emit('fail', TASK, 'Failed');
      trace('session', `failed ${sid}`);
      ensureBeat();
      break;
    }
    case 'session.execution.interrupted': {
      const sid = sessionID(event);
      if (sid) setActive(sid, false);
      if (!isRunning()) emit('fail', TASK, 'Interrupted');
      trace('session', `interrupted ${sid}`);
      ensureBeat();
      break;
    }
    case 'permission.asked':
    case 'form.created':
      setDecision(true);
      break;
    case 'permission.replied':
    case 'permission.rejected':
    case 'form.replied':
    case 'form.cancelled':
      setDecision(false);
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
      setTurnLabel(awaitingDecision ? 'Needs confirmation' : 'OpenCode');
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

    // A reload can land mid-turn: recover the running sessions and processes
    // from the server, then reconcile the board before trusting any event.
    await recoverShells();
    await sync();
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
