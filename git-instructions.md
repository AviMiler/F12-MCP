# Git instructions

- Local repository only; no remote configured. Do not push until a remote is added.
- Integration branch: `main`. Small/regular work may commit directly to `main`; parallel features use `feat-<slug>` branches merged into `main`.
- maxParallelFeatures: 3
- Stage only the files a task touched (never `git add -A`). Run `node --test test/unit.js` before committing code changes.
- Never commit `.claude/` (local agent state).
