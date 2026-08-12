const enabled = process.env.RYZER_TRACE === "1";
const origin = performance.now();

/** Phase instrumentation for startup work. Enabled with RYZER_TRACE=1 so that
 * performance claims can be re-derived instead of re-guessed. */
export function trace(phase: string, detail?: string): void {
  if (!enabled) return;
  const elapsed = (performance.now() - origin).toFixed(1).padStart(8);
  process.stderr.write(`[ryzer ${elapsed}ms] ${phase}${detail ? ` ${detail}` : ""}\n`);
}

export const tracing = enabled;

if (enabled) {
  process.on("exit", () => {
    process.stderr.write(
      `[ryzer ${(performance.now() - origin).toFixed(1).padStart(8)}ms] process:exit\n`,
    );
  });
}
