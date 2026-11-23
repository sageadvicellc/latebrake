// The orphan detector. A fake engine and every helper it starts carry a tag in their argument list. The detector lists the processes of this computer and finds each one that holds the tag
// and is still alive. A test that starts engines ends with `assertNoLeaks`, so a process that a session left behind fails the test and is killed.
import { execFileSync } from 'node:child_process';

export interface Leaked {
  readonly pid: number;
  readonly args: string;
}

/** Lists the live processes whose argument list holds the tag. A zombie is not alive, and this process is never listed. */
export function liveWithTag(tag: string): Leaked[] {
  const table = execFileSync('ps', ['-axo', 'pid=,stat=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const found: Leaked[] = [];
  for (const row of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row);
    if (!match) continue;
    const pid = Number(match[1]), state = match[2] ?? '', args = match[3] ?? '';
    if (pid === process.pid || state.startsWith('Z') || !args.includes(tag)) continue;
    found.push({ pid, args });
  }
  return found;
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Waits up to `ms` for every process with the tag to be gone, and gives the ones that are not. */
export async function leavesBehind(tag: string, ms = 2000): Promise<Leaked[]> {
  const until = Date.now() + ms;
  let live = liveWithTag(tag);
  while (live.length > 0 && Date.now() < until) {
    await pause(25);
    live = liveWithTag(tag);
  }
  return live;
}

/** Kills the processes with the tag. It is the clean-up of a test that found a leak, so that a failing test never leaves a process behind. */
export function killWithTag(tag: string): void {
  for (const { pid } of liveWithTag(tag)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Fails when a process with the tag is still alive after a short wait (`ms`, 2 s by default). It kills what it found first, so the failure leaves nothing behind. */
export async function assertNoLeaks(tag: string, ms = 2000): Promise<void> {
  const left = await leavesBehind(tag, ms);
  if (left.length === 0) return;
  killWithTag(tag);
  throw new Error(`a process was left behind: ${left.map(item => `${item.pid} ${item.args.slice(0, 80)}`).join('; ')}`);
}

/** The live processes that descend from a process, by parent links, whatever their arguments say. The `ps` that lists them is not one of them, and a zombie is not alive. Needs no tag. */
export function liveDescendants(rootPid: number = process.pid): Leaked[] {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows = new Map<number, { readonly ppid: number; readonly state: string; readonly args: string }>();
  for (const row of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(row);
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), state: match[3] ?? '', args: match[4] ?? '' });
  }
  const found: Leaked[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const [pid, row] of rows) {
      if (seen.has(pid) || !frontier.includes(row.ppid)) continue;
      seen.add(pid);
      next.push(pid);
      if (!row.state.startsWith('Z') && !/^ps\s/.test(row.args)) found.push({ pid, args: row.args });
    }
    frontier = next;
  }
  return found;
}

/** Fails when a process still descends from this one after a short wait. It kills what it found first. */
export async function assertNoDescendants(ms = 2000, rootPid: number = process.pid): Promise<void> {
  const until = Date.now() + ms;
  let live = liveDescendants(rootPid);
  while (live.length > 0 && Date.now() < until) {
    await pause(25);
    live = liveDescendants(rootPid);
  }
  if (live.length === 0) return;
  for (const { pid } of live) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  throw new Error(`a child process was left behind: ${live.map(item => `${item.pid} ${item.args.slice(0, 80)}`).join('; ')}`);
}
