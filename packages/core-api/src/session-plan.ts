import type { Billing, ModelChoice } from '../../engine-sessions/src/index.js';
import { escapeForPlan } from './plan-text.js';

const BILLING_TEXT: Readonly<Record<Billing, string>> = {
  'engine-plan': "billing source: the plan of the engine itself, so the core bills no key",
  local: 'billing source: local, so no provider is billed',
};

export interface StartStepsInput {
  readonly gauge: string;
  readonly engine: string;
  readonly title: string;
  readonly program: string;
  readonly folder: string;
  /** The folder as the Gauge wrote it. When it is not the folder above, the plan for the person says so. A plan for a Gauge leaves it out, since its folder is the one the Gauge wrote. */
  readonly requestedFolder?: string;
  readonly model: ModelChoice | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly sharedWith: readonly string[];
}

/**
 * The lines of a start plan, which the person reads and approves. This is the contract, in this order. Every value goes through `escapeForPlan`, so no value can add or forge a line.
 *
 * 1. `Gauge <gauge> asks for a new session of the engine <engine> (<title>)`
 * 2. `program: <path>`: the real path in the plan of the person, and the program as the engine is configured in the plan of a Gauge
 * 3. `folder: <folder>`: the real folder in the plan of the person, and the folder as the Gauge wrote it in the plan of a Gauge. In the plan of the person, when the Gauge wrote another name for the folder (a link, or another spelling),
 *    the next line is `the Gauge named this folder as <name>`
 * 4. `model: <provider> <model>, as the Gauge asks`, or `model: the engine's own default, and the core picks none`
 * 5. `billing source: ...`, one of the two texts of `BILLING_TEXT`
 * 6. `variables passed: <names joined by a comma and a space>`, or `variables passed: none`
 * 7. `the program gets these variables only, and it starts with an argument list and never through a shell`
 * 8. `the core never answers a permission prompt of the engine: you answer it yourself`
 * 9. when the folder is shared: `notice: <engines> already run in this folder, and two engines in one folder can overwrite each other's files`
 *    and `a second approval is needed, for the shared folder`. The plan of the person names every engine. The plan of a Gauge names the engines it may read only, and leaves both lines out when it may read none that shares.
 * 10. `start the program in the folder, and keep the session until it stops or fails`
 */
export function startSteps(input: StartStepsInput): string[] {
  const shared = input.sharedWith.length > 0
    ? [
      `notice: ${input.sharedWith.map(escapeForPlan).join(', ')} already ${input.sharedWith.length === 1 ? 'runs' : 'run'} in this folder, and two engines in one folder can overwrite each other's files`,
      'a second approval is needed, for the shared folder',
    ]
    : [];
  return [
    `Gauge ${escapeForPlan(input.gauge)} asks for a new session of the engine ${escapeForPlan(input.engine)} (${escapeForPlan(input.title)})`,
    `program: ${escapeForPlan(input.program)}`,
    `folder: ${escapeForPlan(input.folder)}`,
    ...(input.requestedFolder !== undefined && input.requestedFolder !== input.folder ? [`the Gauge named this folder as ${escapeForPlan(input.requestedFolder)}`] : []),
    input.model === null ? "model: the engine's own default, and the core picks none" : `model: ${escapeForPlan(input.model.provider)} ${escapeForPlan(input.model.model)}, as the Gauge asks`,
    BILLING_TEXT[input.billing],
    `variables passed: ${input.variables.length > 0 ? input.variables.map(escapeForPlan).join(', ') : 'none'}`,
    'the program gets these variables only, and it starts with an argument list and never through a shell',
    'the core never answers a permission prompt of the engine: you answer it yourself',
    ...shared,
    'start the program in the folder, and keep the session until it stops or fails',
  ];
}

export interface StopStepsInput {
  readonly gauge: string;
  readonly session: string;
  readonly engine: string;
  readonly folder: string;
  /** The folder as the session was asked for. When it is not the folder above, the plan for the person says so. */
  readonly requestedFolder?: string;
  readonly force: boolean;
  /** True when the session has ended (stopped or failed) and the stop is the kill again, because its program has not gone. */
  readonly ended: boolean;
  /** How long the core waits for the engine to go, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * The lines of a stop plan, in this order, every value through `escapeForPlan`:
 *
 * 1. `Gauge <gauge> asks to stop session <session> of the engine <engine>`
 * 2. `folder: <folder>`: the real folder in the plan of the person, and the folder as the session was asked for in the plan of a Gauge. In the plan of the person, when the session was asked for in another name,
 *    the next line is `the session was asked for in the folder <name>`
 * 3. `send the stop signal to the program and everything it started, and wait up to <n> ms for them to go`, or, for a session that is stopping already,
 *    `the session is stopping already: send the kill signal, which the program cannot ignore, to the program and everything it started`, or, for a session that has ended and whose program may still run,
 *    `the session has ended, but its program may still be running: send the kill signal again, ...`
 * 4. `if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT`, or, for a session that has ended, that it keeps its state and that its place is free when the program has gone
 */
export function stopSteps(input: StopStepsInput): string[] {
  return [
    `Gauge ${escapeForPlan(input.gauge)} asks to stop session ${escapeForPlan(input.session)} of the engine ${escapeForPlan(input.engine)}`,
    `folder: ${escapeForPlan(input.folder)}`,
    ...(input.requestedFolder !== undefined && input.requestedFolder !== input.folder ? [`the session was asked for in the folder ${escapeForPlan(input.requestedFolder)}`] : []),
    input.force
      ? (input.ended
        ? 'the session has ended, but its program may still be running: send the kill signal again, which the program cannot ignore, to the program and everything it started'
        : 'the session is stopping already: send the kill signal, which the program cannot ignore, to the program and everything it started')
      : `send the stop signal to the program and everything it started, and wait up to ${input.timeoutMs} ms for them to go`,
    input.force && input.ended
      ? 'the session keeps its state, and its place is free when the program has gone; if it does not go in time, the core refuses with ENGINE_STOP_TIMEOUT'
      : 'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
  ];
}
