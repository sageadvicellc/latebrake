// A program for a test, never imported and not a test itself: it starts a fake engine through the process launcher and then waits. The test ends it in several ways and checks that the engine goes too.
// Usage: node launcher-parent.js <mode> <tag>.
//   exit: leaves by itself once the engine and its helper run.
//   immediate: starts the engine and calls process.exit(0) in the same tick, before any event.
//   own: has a listener of its own for SIGTERM that keeps it alive, and starts a second engine after the first signal.
//   any other mode: waits for a signal from the test.
import { createProcessLauncher } from '../src/process-launcher.js';
import { FAKE_ENGINE_PROGRAM } from '../src/fixtures.js';

const [mode, tag] = process.argv.slice(2);
const launcher = createProcessLauncher();
const start = (suffix: string) => launcher.launch({
  program: process.execPath,
  args: [FAKE_ENGINE_PROGRAM, '--tag', `${tag ?? 'no-tag'}${suffix}`, '--script', JSON.stringify([{ spawnChild: true }, { hold: true }])],
  cwd: process.cwd(),
  env: {},
});
const say = (text: string, then?: () => void) => process.stdout.write(`${text}\n`, then);
const watch = (suffix: string, message: string, then?: () => void) => start(suffix).onLine(line => { if (line.startsWith('child:')) say(message, then); });

if (mode === 'own') {
  let signals = 0;
  process.on('SIGTERM', () => { signals += 1; say(`got:${signals}`, () => { if (signals === 1) watch('-second', 'ready-second'); }); });
}
if (mode === 'immediate') {
  start('');
  process.exit(0);
}
// The engine says `child:<pid>` once its helper is running, so `ready` means that the engine and its helper are both alive. In the mode `exit` the parent leaves only then.
watch('', 'ready', () => { if (mode === 'exit') process.exit(0); });
setInterval(() => undefined, 1000);
