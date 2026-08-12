import { Browser } from "./browser.js";
import { acquireNativePool } from "./native.js";

/** Detached warmer, spawned by the runner as it exits. Never imported.
 *
 * Chrome forks a renderer process the first time a context's page is touched,
 * which costs roughly 250ms and is the largest single item in a warm run. That
 * fork cannot be overlapped with test execution: within one browser process
 * Chrome serializes it against everything else that browser is doing, so
 * parking mid-run stalls the running test, and parking before exit only moves
 * the cost behind process exit.
 *
 * It can be paid by a different process once the run is over. This entry point
 * leaves one context behind in each browser it parks, with the renderer already
 * forked, so the next run adopts it in a few milliseconds. Separate workers own
 * separate Chrome processes, so the forks run in parallel.
 *
 * It takes a real lease rather than reusing the parent's browser endpoints.
 * That is not incidental: the parent has already released, so those browsers
 * may belong to another run by now, and forking a renderer inside a browser
 * that is running someone else's test stalls that test until the fork lands.
 * Leasing makes the browsers exclusively ours for the few hundred milliseconds
 * this takes.
 *
 * Every failure is silent by construction. No daemon, no free slots, or a
 * browser that went away all mean the next run creates its own context,
 * exactly as it would have anyway.
 */
const count = Number(process.argv[2]);
const executablePath = process.argv[3] || undefined;

// This process is detached; it must never outlive its usefulness or hold
// browsers leased against a run that wants them.
setTimeout(() => process.exit(0), 30_000).unref();

if (Number.isInteger(count) && count > 0 && count <= 64) {
  const lease = await acquireNativePool(count, executablePath ? { executablePath } : {}, true);
  if (lease) {
    try {
      await Promise.allSettled(
        lease.slots.map(async (slot) => {
          const browser = await Browser.connect(slot.wsUrl, 5_000);
          try {
            // Bounded to one parked context per browser.
            if (await browser._hasParkedContext()) return;
            await browser._parkWarmContext();
          } finally {
            browser.connection.close();
          }
        }),
      );
    } finally {
      lease.release();
    }
  }
}

process.exit(0);
