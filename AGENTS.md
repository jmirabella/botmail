# Agent notes

- Keep tests minimal: a handful per feature that cover the critical paths. Do not write exhaustive tests.
- Don't add tests for edge cases the critical-path tests already exercise, and don't refactor existing tests unless a change breaks them.
- Run the suite once (`npm run typecheck && npm test`) before opening or updating a PR, not after every edit.
