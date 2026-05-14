# Project Agent Instructions

## Workflow Learning with Git Notes

After a successful workflow and commit, add a structured Git note to the commit documenting how the solution was reached. Use this for future workflow optimization and autoresearch learning.

Prefer concise YAML-style notes with:

- `problem`: what was being solved
- `approach`: the successful strategy
- `failed_paths`: dead ends or incorrect hypotheses
- `verification`: commands/checks that proved success
- `workflow_learning`: reusable lesson for future tasks
- `related_files`: key files touched or studied

Example:

```bash
git notes add -m "problem: Fix failing cache invalidation
approach: Compared cache key inputs and added missing parameter
failed_paths:
  - Suspected stale filesystem cache first
verification:
  - pytest tests/optimize/test_backtesting.py
workflow_learning: For cache bugs, inspect key composition before invalidation logic
related_files:
  - tests/optimize/test_backtesting.py"
```

Show notes with `git log --show-notes`. Share them explicitly when needed with `git push origin refs/notes/commits`.
