import { randomBytes } from 'node:crypto';
import type { JobDefinition, JobReason } from './definition.js';

/** The most jobs the core holds. A create past it is refused with `GAUGE_JOB_LIMIT`. */
export const MAX_JOBS = 64;

/** A job as a read gives it: the id the store made, and the definition that was checked. Frozen. */
export interface Job {
  readonly id: string;
  readonly definition: JobDefinition;
}

/** One job of the list: no task and no folder, only what a person needs to pick one. */
export interface JobListing {
  readonly id: string;
  readonly title: string;
  readonly sessions: number;
}

const JOB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A job id: a short lower-case token. The store makes the ids, so any other shape is a malformed request. */
export function checkJobId(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: Extract<JobReason, 'job'> } {
  return typeof value === 'string' && JOB_ID.test(value) ? { ok: true, value } : { ok: false, reason: 'job' };
}

export interface JobStoreOptions {
  /** The most jobs held: a whole number from 1 to 64. 64 by default. */
  readonly cap?: number;
  /** Makes a job id. `job-` and sixteen hexadecimal characters by default. A bad or repeated id is a bug, and throws. */
  readonly newId?: () => string;
}

export interface JobStore {
  /** The jobs in the order they were made, as a new frozen list. */
  list(): readonly JobListing[];
  /** One job, or `undefined` for an id that no job has (also for a value that is not an id). */
  get(id: string): Job | undefined;
  /** Makes a job from a definition that was checked. `GAUGE_JOB_LIMIT` when the store is full: nothing changes. */
  create(definition: JobDefinition): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: 'GAUGE_JOB_LIMIT' };
  /** Replaces the definition of a job. It keeps the id and its place in the list. Gives false when no job has the id. */
  replace(id: string, definition: JobDefinition): boolean;
  /** Removes a job. Gives false when no job has the id. */
  remove(id: string): boolean;
  readonly size: number;
}

/**
 * The jobs the core holds. A Map keyed by id, so an id such as `__proto__` is only a key (and the check refuses it anyway). Its size is bounded by the cap, and a read gives new frozen values.
 */
export function createJobStore(options: JobStoreOptions = {}): JobStore {
  const cap = options.cap ?? MAX_JOBS;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_JOBS) throw new RangeError(`the job cap is a whole number from 1 to ${MAX_JOBS}`);
  const newId = options.newId ?? ((): string => `job-${randomBytes(8).toString('hex')}`);
  const jobs = new Map<string, JobDefinition>();
  return {
    list: () => Object.freeze([...jobs].map(([id, definition]) => Object.freeze({ id, title: definition.title, sessions: definition.sessions.length }))),
    get(id) {
      const definition = jobs.get(id);
      return definition === undefined ? undefined : Object.freeze({ id, definition });
    },
    create(definition) {
      if (jobs.size >= cap) return { ok: false, code: 'GAUGE_JOB_LIMIT' };
      // The id is made before anything changes, so an id that throws or is bad leaves the store as it was.
      const id = newId();
      if (!checkJobId(id).ok || jobs.has(id)) throw new Error('job store: newId gave a job id that is malformed or already used');
      jobs.set(id, definition);
      return { ok: true, id };
    },
    replace(id, definition) {
      if (!jobs.has(id)) return false;
      jobs.set(id, definition);
      return true;
    },
    remove(id) {
      return jobs.delete(id);
    },
    get size() { return jobs.size; },
  };
}
