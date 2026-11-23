// A program for a test, never imported and not a test itself: it starts a fake engine through the process launcher, says `ready`, and then waits. The test ends it in three ways and checks that the engine goes too.
// Usage: node launcher-parent.js <mode> <tag>. In the mode `exit` it exits by itself once the engine runs.
import { createProcessLauncher } from '../src/process-launcher.js';
import { FAKE_ENGINE_PROGRAM } from '../src/fixtures.js';

const [mode, tag] = process.argv.slice(2);
const handle = createProcessLauncher().launch({
  program: process.execPath,
  args: [FAKE_ENGINE_PROGRAM, '--tag', tag ?? 'no-tag', '--script', JSON.stringify([{ spawnChild: true }, { hold: true }])],
  cwd: process.cwd(),
  env: {},
});
handle.onSpawn(() => {
  process.stdout.write('ready\n', () => {
    if (mode === 'exit') process.exit(0);
  });
});
setInterval(() => undefined, 1000);
