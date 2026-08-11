# Contributing to Ryzer

Ryzer requires Node.js 20 or newer, npm, Rust, and a local Chromium or Chrome installation.

```bash
npm ci
npm run check
npm run build
npm run test:unit
npm test
cargo fmt --manifest-path native/ryzerd/Cargo.toml -- --check
cargo clippy --manifest-path native/ryzerd/Cargo.toml -- -D warnings
```

Run `npm run format` to apply Oxfmt. Oxlint, Oxfmt, TypeScript, Rust, and browser regressions are
required in CI.

For a user-visible change, run `npm run changeset` and commit the generated file. Choose:

- `patch` for fixes and safe performance improvements;
- `minor` for backward-compatible features;
- `major` for breaking API or behavior changes.

Pull requests target `main`. Direct pushes, force pushes, and branch deletion are protected. The
Changesets workflow creates a version PR; merging it publishes through npm trusted publishing.
