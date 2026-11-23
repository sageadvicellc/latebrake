/**
 * The seam between the host and the operating system. The host never starts a process itself: it asks a launcher. The process launcher starts a real program,
 * and a test can pass a launcher of its own. A launcher starts a program with an argument list, never through a shell, in a folder, with the environment it is given and no more.
 */

/** What to start. `env` is the whole environment of the program: the launcher adds nothing to it. */
export interface LaunchSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Which signal to send to the program and everything it started. `term` asks it to stop, and it may refuse. `kill` cannot be refused. */
export type StopSignal = 'term' | 'kill';

/** A program that was started, or that failed to start. Each listener is added in the same tick as the launch, before any event can fire. */
export interface Launched {
  /** Called once, when the program is running. */
  onSpawn(listener: () => void): void;
  /** Called once, when the program could not be started. Then no spawn and no exit follow. */
  onError(listener: (error: Error) => void): void;
  /** Called for each line the program writes to its standard output, cut at 4,096 characters. Standard error is read, and its end comes with the exit. */
  onLine(listener: (line: string) => void): void;
  /**
   * Called once, when the program and everything it started in its group are gone. `code` is the exit code, or `null` when a signal ended it. `stderrTail` is the last 2,048 characters of its standard error,
   * for the log of a session that failed. It is text that the program wrote, so a reader escapes it.
   */
  onExit(listener: (code: number | null, signal: string | null, stderrTail: string) => void): void;
  /** Sends a signal to the program and everything it started. It never throws, and does nothing once they are gone. */
  signal(kind: StopSignal): void;
}

export interface Launcher {
  /** Starts a program. A throw here is a failed start, and the host marks the session failed. */
  launch(spec: LaunchSpec): Launched;
}
