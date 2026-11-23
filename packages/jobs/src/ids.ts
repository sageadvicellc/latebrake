import type { JobReason } from './definition.js';

/**
 * The shapes of the ids of jobs and runs, and the cap on jobs. This module is pure, with no `node:` import, so the Core API client can check an id without reaching the store or the run book.
 */

/** The most jobs the core holds. A create past it is refused with `GAUGE_JOB_LIMIT`. */
export const MAX_JOBS = 64;

const JOB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A job id: a short lower-case token. The store makes the ids, so any other shape is a malformed request. */
export function checkJobId(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: Extract<JobReason, 'job'> } {
  return typeof value === 'string' && JOB_ID.test(value) ? { ok: true, value } : { ok: false, reason: 'job' };
}

/** True for a run id: a short lower-case token. */
export const isRunId = (value: unknown): value is string => typeof value === 'string' && RUN_ID.test(value);
