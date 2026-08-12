---
"ryzer": patch
---

Load TypeScript test files through Node's own type stripper instead of esbuild. The previous fast-lane check rejected any file containing a relative import, which excluded essentially every real spec file; a resolve hook now maps `./foo.js` onto `./foo.ts` so only non-erasable syntax falls back to `tsx`. Measured 296ms to 33ms for twelve spec files importing shared helpers.

Fix a bug in the native SHA-256 that discarded buffered bytes between `update` calls. Symlink digests were a function of the target's length alone, so repointing a symlink at a same-length path could not invalidate an `--incremental` cache, and the native and JavaScript fingerprint engines disagreed on every symlink. `CACHE_VERSION` moves to 4 so caches holding the old digests are discarded.

Hash fingerprint entries across available cores: 685ms to 155ms for a 2189-file tree.

Keep daemon-owned browsers warm for an hour instead of ten minutes, so an ordinary interruption no longer costs the next run a cold Chrome launch per worker.

Add `RYZER_TRACE=1` startup phase instrumentation and a multi-file suite benchmark.
