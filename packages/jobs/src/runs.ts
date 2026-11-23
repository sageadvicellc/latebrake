import { randomBytes } from 'node:crypto';
import type { BegunStart, EngineHost, GroupRefusal, StartPlanContent } from '../../engine-sessions/src/host.js';
import type { ModelChoice } from '../../engine-sessions/src/request.js';
import type { SessionState } from '../../engine-sessions/src/states.js';
import type { Billing, StartFailedReason } from '../../engine-sessions/src/vocab.js';
import { escapeText } from '../../engine-sessions/src/text.js';
import { isRunId } from './ids.js';
import type { Job } from './store.js';

export { isRunId };

/**
 * The run book. A run is one execution of a job: a group of sessions that start from one plan. The book plans a run from a job, begins every session of it as one group of the Engine Host, reads a run as a
 * group of its sessions, and undoes a run whose start failed part way. It never starts an engine that the plan does not list, and no call adds a session to a run that has begun.
 */

/** What the person approves for one session of a run. `sharedWith` lists every other engine in the folder: those that run there now and those that the run starts there. */
export interface RunSessionPlan {
  readonly label: string;
  readonly engine: string;
  readonly engineTitle: string;
  readonly harness: string;
  readonly program: string;
  readonly folder: string;
  readonly model: ModelChoice | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly sharedWith: readonly string[];
  readonly task: string;
}

/** What the person approves for a run: every session, in the order of the job. `shared` is true when any session shares its folder, and then the run needs the second approval. */
export interface RunPlanContent {
  readonly job: string;
  readonly title: string;
  readonly shared: boolean;
  readonly sessions: readonly RunSessionPlan[];
}

/** A run that was planned: what the person reads, and the plans of the host that begin it. Begin it in the same tick, as it came. */
export interface PlannedRun {
  readonly plan: RunPlanContent;
  readonly start: readonly StartPlanContent[];
}

/** A session of a run as a read gives it. `forgotten`: the host no longer keeps the session, because newer sessions pushed it out of its history. */
export type RunSessionState = SessionState | 'forgotten';

export interface RunSessionView {
  readonly label: string;
  readonly engine: string;
  readonly session: string;
  readonly state: RunSessionState;
}

/** A run as a group of its sessions, in the order of the plan. The group holds no state of its own: it is what its sessions are. */
export interface RunView {
  readonly id: string;
  readonly job: string;
  readonly title: string;
  readonly sessions: readonly RunSessionView[];
}

/** The session of a run that a refusal is about: its place in the plan (the first is 0) and its label. Both are closed values: a place of at most 7, and a label that the definition check accepted. */
export interface RunMember {
  readonly index: number;
  readonly label: string;
}

/** A refusal of a plan or of a begin for one session: the refusal of the host, its `index`, and the label of that session. */
export type RunRefusal = GroupRefusal & { readonly label: string };

/**
 * How a run ended its start. Every session said that it runs: `ok`. Or the first failure, in the order that things happened and not in the order of the plan, which is the cause of the others, and the sessions
 * that had started were stopped: `ENGINE_START_FAILED` with its reason, the id of the run (the run stays recorded and reads as a group that ended), and the session that failed. Or an undo that could not stop a session:
 * `GAUGE_RUN_ROLLBACK_FAILED`, with the same run, session, and the reason of the first failure as `cause`.
 */
export type RunOutcome =
  | { readonly ok: true; readonly run: string }
  | { readonly ok: false; readonly code: 'ENGINE_START_FAILED'; readonly reason: StartFailedReason; readonly run: string; readonly member: RunMember }
  | { readonly ok: false; readonly code: 'GAUGE_RUN_ROLLBACK_FAILED'; readonly run: string; readonly member: RunMember; readonly cause: StartFailedReason };

export interface BegunRun {
  readonly ok: true;
  readonly run: string;
  /** The session ids, in the order of the plan. */
  readonly sessions: readonly string[];
  /**
   * Resolves when every session has left `starting`: all of them say that they run (a spawn is not enough), or the first one that fails, or times out, or is stopped, starts the undo of all of them at once, and the
   * outcome comes when the undo is done. It is bounded by the start timeout of the host.
   */
  readonly settled: Promise<RunOutcome>;
}

export interface RunBookOptions {
  readonly host: EngineHost;
  /** Makes a run id. `run-` and sixteen hexadecimal characters by default. A bad or repeated id is a bug, and throws before any session starts. */
  readonly newId?: () => string;
  /** Receives a line about an undo that could not stop a session, with every value escaped. Standard error by default. A log that throws never stops an outcome. */
  readonly log?: (message: string) => void;
}

export interface RunBook {
  /** Plans a run of a job from live state. It changes nothing. A refusal is the refusal of the host for the first session that cannot start, with its `index` and its label. */
  plan(job: Job): ({ readonly ok: true } & PlannedRun) | RunRefusal;
  /**
   * Begins a run: every session starts before this returns, and the run is recorded at once. `sharedApproved` is the second approval, and only the value `true` counts. A refusal starts nothing and records nothing.
   * The plan must be the one `plan` gave in this tick: one that no longer matches the state is a bug of the caller, and throws.
   */
  begin(planned: PlannedRun, approvals: { readonly sharedApproved: boolean }): BegunRun | RunRefusal;
  /** The runs, oldest first. A run whose sessions the host has all dropped is no longer listed. */
  list(): readonly RunView[];
  /** One run, or `undefined`. */
  get(id: string): RunView | undefined;
  /** How many runs the book holds a record of now, without pruning first. A call to `begin` prunes before it adds, so the number stays within one of what the host keeps. */
  readonly size: number;
}

interface Member {
  readonly label: string;
  readonly engine: string;
  readonly session: string;
}
interface Recorded {
  readonly job: string;
  readonly title: string;
  readonly members: readonly Member[];
}

const sortedUnique = (names: Iterable<string>): string[] => [...new Set(names)].sort();

export function createRunBook(options: RunBookOptions): RunBook {
  const host = options.host;
  const newId = options.newId ?? ((): string => `run-${randomBytes(8).toString('hex')}`);
  const log = options.log ?? ((message: string): void => { process.stderr.write(`${message}\n`); });
  /** Writes one line to the log. A log that throws is reported on standard error, and never reaches the caller. Every value is escaped by the caller of this. */
  const say = (message: string): void => {
    try {
      log(message);
    } catch (error) {
      process.stderr.write(`run book: the log threw: ${escapeText(error instanceof Error ? error.message : String(error))}\n`);
    }
  };
  /** Every run that has begun and that the host still keeps a session of, in the order they began. A Map, so an id such as `__proto__` is only a key. */
  const runs = new Map<string, Recorded>();

  /**
   * The history of the book is the history of the host. The host keeps every live session and the newest 256 that have ended, and drops the one that ended first. A run is kept while the host keeps any of its
   * sessions, so a run is dropped when its last session is, and the order is the order the sessions ended. The book keeps no clock of its own, and it holds at most one record for each session the host keeps.
   */
  const prune = (): void => {
    for (const [id, run] of runs) if (run.members.every(member => host.get(member.session) === undefined)) runs.delete(id);
  };

  const view = (id: string, run: Recorded): RunView => Object.freeze({
    id, job: run.job, title: run.title,
    sessions: Object.freeze(run.members.map((member): RunSessionView => Object.freeze({ label: member.label, engine: member.engine, session: member.session, state: host.get(member.session)?.state ?? 'forgotten' }))),
  });

  /** Stops a session of an undone run, and asks again with the kill signal when the first stop times out. True when the session has gone or was gone already. A session that stays is logged, with the cause. */
  async function undo(run: string, session: string): Promise<boolean> {
    const where = `the stop of session ${escapeText(session)} for the run ${escapeText(run)}`;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stopped = await host.stop(session);
        if (stopped.ok) return true;
        // A session that has ended and gone, or that the host no longer holds, needs nothing more.
        if (stopped.code === 'ENGINE_SESSION_ENDED' || stopped.code === 'ENGINE_SESSION_UNKNOWN') return true;
        if (stopped.code !== 'ENGINE_STOP_TIMEOUT') {
          say(`run book: ${where} was refused: ${escapeText(stopped.code)}`);
          return false;
        }
      }
      say(`run book: session ${escapeText(session)} of the run ${escapeText(run)} did not go in time, also after the kill signal`);
    } catch (error) {
      // A host that throws did not stop the session. The undo says so, and `settled` still resolves.
      say(`run book: ${where} threw: ${escapeText(error instanceof Error ? error.message : String(error))}`);
    }
    return false;
  }

  /**
   * Waits until every session has left `starting`. The first session that does not run (it failed, timed out, was stopped, or its program ended before it said it runs) starts the stop of every session of the run at once,
   * and the wait goes on for the others, which the stop brings out of `starting` too. Only that first failure is the answer, and it is logged with its session: the others are its consequence.
   */
  async function settle(run: string, plan: RunPlanContent, members: readonly BegunStart[]): Promise<RunOutcome> {
    let first: { readonly member: RunMember; readonly reason: StartFailedReason } | undefined;
    let undoing: Promise<boolean[]> | undefined;
    await Promise.all(members.map((begun, index) => begun.started.then(result => {
      if (result.ok || first !== undefined) return;
      const label = plan.sessions[index]?.label;
      if (label === undefined) throw new Error('run book: a member has no session in the plan');
      const reason = result.code === 'ENGINE_START_FAILED' ? result.reason : 'other';
      first = { member: { index, label }, reason };
      say(`run book: the start of session ${escapeText(begun.session)} (${escapeText(label)}) of the run ${escapeText(run)} failed: ${escapeText(result.code)} ${escapeText(reason)}`);
      // One session did not start, so no session of the run is left running: the person approved a run, and a part of it is not one.
      undoing = Promise.all(members.map(other => undo(run, other.session)));
    })));
    if (first === undefined || undoing === undefined) return { ok: true, run };
    const undone = await undoing;
    return undone.every(done => done)
      ? { ok: false, code: 'ENGINE_START_FAILED', reason: first.reason, run, member: first.member }
      : { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run, member: first.member, cause: first.reason };
  }

  /** The label of the session at a place of the plan. */
  const labelAt = (plan: RunPlanContent, index: number): string => {
    const label = plan.sessions[index]?.label;
    if (label === undefined) throw new Error('run book: a refusal names a session that the plan does not hold');
    return label;
  };

  return {
    plan(job) {
      const grouped = host.planStartGroup(job.definition.sessions.map(session => ({ engine: session.engine, folder: session.folder, model: session.model })));
      if (!grouped.ok) {
        const named = job.definition.sessions[grouped.index];
        if (named === undefined) throw new Error('run book: a refusal names a session that the job does not hold');
        return { ...grouped, label: named.label };
      }
      const sessions = grouped.plans.map((start, index): RunSessionPlan => {
        const defined = job.definition.sessions[index];
        if (defined === undefined) throw new Error('run book: the host planned more sessions than the job holds');
        // Every other engine in the folder: those that run there now (the host lists them for the members after the first) and the other members of this run.
        const others = grouped.plans.filter((other, at) => at !== index && other.folder === start.folder).map(other => other.engine);
        return Object.freeze({
          label: defined.label, engine: start.engine, engineTitle: start.title, harness: defined.harness, program: start.program, folder: start.folder, model: start.model, billing: start.billing,
          variables: Object.freeze([...start.variables]), sharedWith: Object.freeze(sortedUnique([...start.sharedWith, ...others])), task: defined.task,
        });
      });
      const plan: RunPlanContent = Object.freeze({ job: job.id, title: job.definition.title, shared: sessions.some(session => session.sharedWith.length > 0), sessions: Object.freeze(sessions) });
      return { ok: true, plan, start: grouped.plans };
    },
    begin(planned, approvals) {
      if (planned.start.length !== planned.plan.sessions.length) throw new Error('run book: the plan holds a different number of sessions than the host plans');
      // The plans of the host and the sessions of the plan go by position, so they must be the same engines in the same order.
      if (planned.start.some((start, index) => start.engine !== planned.plan.sessions[index]?.engine)) throw new Error('run book: the engine of a plan of the host is not the engine of the plan in that place');
      prune();
      // The id is made before any session starts, so an id that throws or is bad leaves nothing running.
      const id = newId();
      if (!isRunId(id) || runs.has(id)) throw new Error('run book: newId gave a run id that is malformed or already used');
      const group = host.beginStartGroup(planned.start, approvals);
      if (!group.ok) return { ...group, label: labelAt(planned.plan, group.index) };
      runs.set(id, {
        job: planned.plan.job, title: planned.plan.title,
        members: planned.plan.sessions.map((session, index) => {
          const begun = group.members[index];
          if (begun === undefined) throw new Error('run book: the host began fewer sessions than the plan holds');
          return { label: session.label, engine: session.engine, session: begun.session };
        }),
      });
      return { ok: true, run: id, sessions: group.members.map(member => member.session), settled: settle(id, planned.plan, group.members) };
    },
    list() {
      prune();
      return Object.freeze([...runs].map(([id, run]) => view(id, run)));
    },
    get(id) {
      prune();
      const run = runs.get(id);
      return run === undefined ? undefined : view(id, run);
    },
    get size() { return runs.size; },
  };
}
