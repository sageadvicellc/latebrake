import { hashDefinition, type JobDefinition, type JobSession } from '../../jobs/src/definition.js';
import type { ModelChoice } from '../../engine-sessions/src/request.js';
import type { Billing } from '../../engine-sessions/src/vocab.js';
import { escapeForPlan } from './plan-text.js';
import type { JobKind } from './types.js';

/** How much of a task a plan shows, in characters of text (never a part of one). The plan says the full count. */
export const TASK_EXCERPT_CHARS = 120;

/** What a plan says about the harness of a session: it is a record, and nothing applies it. */
const HARNESS_LINE = 'the harness of each session is recorded and shown here, and nothing applies it to an engine yet';

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** The first 120 characters of a task, escaped, with `...` when the task is longer. The count is of characters of text, so a cut never falls inside one. */
function taskLine(prefix: string, task: string): string {
  const characters = [...task];
  const shown = characters.length > TASK_EXCERPT_CHARS ? `${escapeForPlan(characters.slice(0, TASK_EXCERPT_CHARS).join(''))}...` : escapeForPlan(task);
  return `${prefix}${characters.length} characters: ${shown}`;
}

const modelText = (model: ModelChoice | null): string => (model === null ? 'the model is the default of the engine' : `model ${escapeForPlan(model.provider)} ${escapeForPlan(model.model)}`);

export interface JobStepsInput {
  readonly kind: JobKind;
  readonly gauge: string;
  /** The id of the job. `null` for a create, since the core makes the id when the plan is applied. */
  readonly job: string | null;
  /** The job as it is now. `null` for a create. */
  readonly before: JobDefinition | null;
  /** The definition the change gives. `null` for a delete. */
  readonly definition: JobDefinition | null;
  /** The hash of the job before, and of the definition after. `null` where there is none. */
  readonly baseHash: string | null;
  readonly nextHash: string | null;
}

function sessionLines(session: JobSession, index: number): string[] {
  return [
    `session ${index + 1}, ${escapeForPlan(session.label)}: engine ${escapeForPlan(session.engine)}, harness ${escapeForPlan(session.harness)}, folder ${escapeForPlan(session.folder)}, ${modelText(session.model)}`,
    taskLine(`task of session ${index + 1}, `, session.task),
  ];
}

/**
 * The lines of a job plan, which the person reads and approves. This is the contract, in this order. Every value goes through `escapeForPlan`, so no value can add or forge a line.
 *
 * 1. The change: `Gauge <gauge> asks to create a job: <title>`, `Gauge <gauge> asks to replace the job <id>, <title now>, with the job below`, or `Gauge <gauge> asks to delete the job <id>, <title>`
 * 2. An update only: `new title: <title>`
 * 3. `the job holds <n> session(s)` (the sessions of the new job, or of the job to delete), and for an update `the job held <n> session(s) and will hold <m> session(s)`
 * 4. For a create or an update, for each session, two lines: its label, engine, harness, folder, and model, and its task (the full count of characters and the first 120)
 * 5. A create: `a job is a saved definition: creating it starts no session, and a run needs a plan of its own`, then (for a create or an update) the harness line, and a create then `the core makes the id of the job when you approve`.
 *    An update: `the job keeps its id, and a run that began already is not changed`. A delete: `deleting a job stops no session: a run that began already goes on, and it keeps the title of the job`
 *    The harness line is `the harness of each session is recorded and shown here, and nothing applies it to an engine yet`: it says what is true, since the Engine Host has no way yet to apply a harness.
 * 6. The last line binds the change to the two hashes: `bind the change to job <hash or none> and result <hash or none>`
 */
export function jobSteps(input: JobStepsInput): string[] {
  const gauge = escapeForPlan(input.gauge);
  const job = input.job === null ? '' : escapeForPlan(input.job);
  const shown = input.definition ?? input.before;
  const count = shown?.sessions.length ?? 0;
  const head = input.kind === 'create'
    ? `Gauge ${gauge} asks to create a job: ${escapeForPlan(input.definition?.title ?? '')}`
    : input.kind === 'update'
      ? `Gauge ${gauge} asks to replace the job ${job}, ${escapeForPlan(input.before?.title ?? '')}, with the job below`
      : `Gauge ${gauge} asks to delete the job ${job}, ${escapeForPlan(input.before?.title ?? '')}`;
  const tail = input.kind === 'create'
    ? ['a job is a saved definition: creating it starts no session, and a run needs a plan of its own', HARNESS_LINE, 'the core makes the id of the job when you approve']
    : input.kind === 'update'
      ? ['the job keeps its id, and a run that began already is not changed', HARNESS_LINE]
      : ['deleting a job stops no session: a run that began already goes on, and it keeps the title of the job'];
  const before = input.before?.sessions.length ?? 0;
  return [
    head,
    ...(input.kind === 'update' ? [`new title: ${escapeForPlan(input.definition?.title ?? '')}`] : []),
    input.kind === 'update'
      ? `the job held ${before} ${plural(before, 'session', 'sessions')} and will hold ${count} ${plural(count, 'session', 'sessions')}`
      : `the job holds ${count} ${plural(count, 'session', 'sessions')}`,
    ...(input.definition?.sessions ?? []).flatMap(sessionLines),
    ...tail,
    `bind the change to job ${input.baseHash ?? 'none'} and result ${input.nextHash ?? 'none'}`,
  ];
}

/** What a run plan shows for one session. */
export interface RunStepsSession {
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

export interface RunStepsInput {
  readonly gauge: string;
  readonly job: string;
  readonly title: string;
  readonly shared: boolean;
  readonly sessions: readonly RunStepsSession[];
}

const BILLING_TEXT: Readonly<Record<Billing, string>> = {
  'engine-plan': 'billing source: the plan of the engine itself, so the core bills no key',
  local: 'billing source: local, so no provider is billed',
};

/**
 * The lines of a run plan, which the person reads and approves once for the whole run. This is the contract, in this order. Every value goes through `escapeForPlan`.
 *
 * 1. `Gauge <gauge> asks to run the job <id>, <title>: <n> session(s) start(s) together`
 * 2. For each session, in the order of the job: `session <i> of <n>, <label>: the engine <engine> (<title>), harness <harness>`, then `program:`, `folder:`, the model line, the billing line, `variables passed:`,
 *    and the task (the full count of characters and the first 120). A session that shares its folder has `notice for session <i>: <engines> also run(s) in this folder, and two engines in one folder can overwrite each other's files`.
 * 3. The closing lines, in this order: how the programs start, that the core never answers a permission prompt, that the core does not send a task to an engine, the harness line (as in a job plan), that the run waits until every
 *    session has said that it runs (and a session that has not said so when the start timeout of the host ends counts as failed), what happens when a session fails (the sessions that started are stopped, only the first failure is
 *    reported, and a session that cannot be stopped is left running for the person to stop), and that the run is interactive.
 * 4. When any session shares a folder: `a second approval is needed, once for the whole run, for the shared folder`
 * 5. `start every program in its folder at once, and keep each session until it stops or fails`
 */
export function runSteps(input: RunStepsInput): string[] {
  const total = input.sessions.length;
  const lines: string[] = [`Gauge ${escapeForPlan(input.gauge)} asks to run the job ${escapeForPlan(input.job)}, ${escapeForPlan(input.title)}: ${total === 1 ? '1 session starts' : `${total} sessions start together`}`];
  for (const [index, session] of input.sessions.entries()) {
    const at = index + 1;
    lines.push(
      `session ${at} of ${total}, ${escapeForPlan(session.label)}: the engine ${escapeForPlan(session.engine)} (${escapeForPlan(session.engineTitle)}), harness ${escapeForPlan(session.harness)}`,
      `program: ${escapeForPlan(session.program)}`,
      `folder: ${escapeForPlan(session.folder)}`,
      session.model === null ? "model: the engine's own default, and the core picks none" : `model: ${escapeForPlan(session.model.provider)} ${escapeForPlan(session.model.model)}, as the job says`,
      BILLING_TEXT[session.billing],
      `variables passed: ${session.variables.length > 0 ? session.variables.map(escapeForPlan).join(', ') : 'none'}`,
      taskLine('task of ', session.task),
    );
    if (session.sharedWith.length > 0) {
      lines.push(`notice for session ${at}: ${session.sharedWith.map(escapeForPlan).join(', ')} also ${session.sharedWith.length === 1 ? 'runs' : 'run'} in this folder, and two engines in one folder can overwrite each other's files`);
    }
  }
  lines.push(
    'each program gets its variables only, and starts with an argument list and never through a shell',
    'the core never answers a permission prompt of an engine: you answer each yourself',
    'the core does not send a task to an engine: you give it in the pane of the engine',
    HARNESS_LINE,
    'the run waits until every session has said that it runs, and a session that has not said so when the start timeout of the host ends counts as failed',
    'if one session fails, or ends before it says it runs, the core stops the sessions that started and reports the first failure only; a session that cannot be stopped is left running, and you stop it yourself',
    'the run is interactive: you watch it, and nothing is scheduled and nothing runs unattended',
  );
  if (input.shared) lines.push('a second approval is needed, once for the whole run, for the shared folder');
  lines.push('start every program in its folder at once, and keep each session until it stops or fails');
  return lines;
}

/** The hash that a plan for a job holds for a definition. */
export const planHash = hashDefinition;
