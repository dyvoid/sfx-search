# Git Strategy for sfx-search

## Core Approach: Trunk-Based Development

Single `main` branch. Short-lived branches (hours, not days). Everything merges fast or gets scrapped.

Direct commits to `main` are the exception, not the norm -- see [Branch Protection](#branch-protection)
for the two cases where they're allowed.

---

## Branch Naming

```
main
task/m1-indexer-pipeline
experiment/clap-fp16-eval
fix/windows-long-path-hash
```

---

## Merging

- **Fast-forward only** -- no merge commits, keeps history linear
- **Rebase onto `main`** before merging, never merge `main` into your branch
- **No squashing** -- each atomic commit is a meaningful unit; squashing destroys the audit trail

---

## Commits

One commit = one AI task or prompt session. Keep commits atomic and scoped.

AI-generated code has no inherent intent -- the commit message is the only record of *why* this code
exists. Use [Conventional Commits](https://www.conventionalcommits.org):

```
feat(index): add deterministic 10s/5s audio windowing
fix(decode): handle extended-length Windows paths in ffprobe call
chore(deps): lock Python dependencies with uv
```

Annotate AI-assisted commits in the body, not the subject, to keep the subject readable:

```
feat(search): implement reciprocal rank fusion over chunks and BM25

ai-assisted: <model>
```

---

## Feature Flags

Use config toggles (`config.toml`) or feature flags to manage incomplete or experimental work on `main` (for example, `loop_score` estimation or alternative embedding checkpoints). Merge when the code is safe; enable by default when verified by the evaluation harness.

---

## Generated Sources

Do not commit generated source files, LanceDB data directories (`data/`), waveform peak caches, or evaluation output runs (`eval/runs/`). Commit lockfiles (`uv.lock`, `package-lock.json`) for reproducibility; regenerate everything else from source.

---

## Code Review

Review diffs skeptically -- AI code looks clean but can be subtly wrong.

High-blast-radius files always get manual review:

- `.gitignore` and `.gitattributes`
- Dependency manifests and lockfiles (`pyproject.toml`, `uv.lock`, `package.json`, `package-lock.json`)
- Anything touching filesystem path resolution, subprocess execution, or network bindings
- CI/CD config

---

## CI

CI is load-bearing for trunk-based development -- slow or weak pipelines break the entire strategy.

Before anything merges to `main`:

- Linting, formatting, and type checks must pass (`ruff`, `black --check`, `mypy` for Python; `eslint`, `tsc --noEmit` for Web)
- All existing `pytest` tests must pass (including window determinism, manifest diffing, and path normalization)
- New code must be covered by tests -- AI optimizes for code that *looks* correct, not code that *is* correct
- Build must succeed

---

## Branch Protection

Enforce the strategy at the repo level on GitHub:

- No direct push to `main`, with two exceptions:
  - Non-functional changes (documentation, comments, formatting) that touch no runtime behavior
  - The user has explicitly authorized a direct commit to `main` for this change
- Neither exception is a standing default -- re-evaluate every time. When in doubt, branch.
- Require fast-forward / rebase-based merges
- Require CI to pass before merge

---

## Versioning

Tag meaningful milestones (`v0.1.0-m1`, `v0.2.0-m2`, etc.) aligned with the milestones in `build_spec.md` and `docs/ROADMAP.md`.
