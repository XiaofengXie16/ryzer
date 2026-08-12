# ryzer

## 1.0.3

### Patch Changes

- 011b9da: Pay Chrome's renderer fork between runs instead of during them, on platforms where it is expensive. Chrome forks renderers from a zygote on Linux and has none on macOS: the first renderer-bound command on a fresh context measures 12-24ms on Linux and 180-227ms on macOS. Where it is costly, a detached warmer now leaves one context per browser with its renderer already forked and the next run adopts it in milliseconds. The warmer holds a real lease that the daemon grants only when the pool is fully idle, so it never delays a run or grows the pool. Measured on a 12-file suite: macOS 2.254s to 0.459s. Gated to macOS because the same A/B on Linux was a loss.

  Load TypeScript test files through Node's own type stripper instead of esbuild. The previous fast-lane check rejected any file containing a relative import, which excluded essentially every real spec file; a resolve hook now maps `./foo.js` onto `./foo.ts` so only non-erasable syntax falls back to `tsx`. Measured 296ms to 33ms for twelve spec files importing shared helpers.

  Fix a bug in the native SHA-256 that discarded buffered bytes between `update` calls. Symlink digests were a function of the target's length alone, so repointing a symlink at a same-length path could not invalidate an `--incremental` cache, and the native and JavaScript fingerprint engines disagreed on every symlink. `CACHE_VERSION` moves to 4 so caches holding the old digests are discarded.

  Hash fingerprint entries across available cores: 685ms to 155ms for a 2189-file tree.

  Keep daemon-owned browsers warm for an hour instead of ten minutes, so an ordinary interruption no longer costs the next run a cold Chrome launch per worker.

  Add `RYZER_TRACE=1` startup phase instrumentation and a multi-file suite benchmark.

## 1.0.2

### Patch Changes

- 36071c9: Read the CLI version from the package manifest so Changesets releases always report the published version.

## 1.0.1

### Patch Changes

- 155ab0e: Stabilize SPA navigation boundaries by retrying Chrome's explicit aborted-navigation signal and locator evaluation across execution-realm replacement.

## 1.0.0

### Major Changes

- Published the stable Ryzer release with the TypeScript/JavaScript API, native Chrome pool, compiled
  Flow transactions, deterministic virtual time, dependency-aware incremental capsules, Oxc quality
  gates, Changesets releases, and npm trusted publishing.

## 0.5.0

### Minor Changes

- Introduced the Ryzer TypeScript/JavaScript browser test runner, native Chrome pool, compiled Flow
  transactions, deterministic virtual time, and dependency-aware incremental result capsules.
