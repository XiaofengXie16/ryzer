# Changesets

Every user-visible change should include a changeset:

```bash
npm run changeset
```

Choose `patch`, `minor`, or `major`, then commit the generated Markdown file with the change.
On `main`, the release workflow maintains a version PR. Merging that PR publishes the package to
npm through trusted publishing and creates the matching GitHub tag and release.
