// A compile-time check: the plan of the person and the plan of a Gauge are two types that no value of one fits as the other. `npm run typecheck` fails when a plan of the person can be returned as a plan that a Gauge reads, or the other way.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonRunPlan, PersonSessionPlan, RunPlan, RunPlanSession, SessionPlan } from '../src/types.js';
import type { RunPlanSession as ExportedRunPlanSession, PersonPlan } from '../src/index.js';

const reply = (plan: SessionPlan): SessionPlan => plan;
const runReply = (plan: RunPlan): RunPlan => plan;
const sessionReply = (session: RunPlanSession): RunPlanSession => session;
const approval = (plan: PersonSessionPlan): PersonSessionPlan => plan;

test('a plan of the person is not a plan of a Gauge, and a plan of a Gauge is not a plan of the person', () => {
  const person = {} as PersonSessionPlan, personRun = {} as PersonRunPlan, seen = {} as SessionPlan, seenRun = {} as RunPlan;
  // @ts-expect-error a plan of the person cannot be given as the reply that a Gauge reads
  reply(person);
  // @ts-expect-error a run plan of the person cannot be given as the reply that a Gauge reads
  runReply(personRun);
  // @ts-expect-error a plan that a Gauge reads cannot stand for the plan that the person approves
  approval(seen);
  // @ts-expect-error a run plan that a Gauge reads cannot stand for the plan that the person approves
  const run: PersonRunPlan = seenRun;
  // @ts-expect-error a session of a person's run plan cannot be given as a session that a Gauge reads
  const unused = (): RunPlanSession => sessionReply(personRun.sessions[0]!);
  // The types are exported for a core and an approval screen to use.
  const exported: ExportedRunPlanSession[] = [], either: PersonPlan[] = [];
  assert.deepEqual([exported, either, typeof run, typeof unused], [[], [], 'object', 'function']);
});
