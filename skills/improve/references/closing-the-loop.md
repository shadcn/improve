# Closing the Loop — execute, reconcile, issues

The advisor's job doesn't end at the plan. This file covers the three follow-through flows: dispatching an executor and reviewing its work (`execute`), keeping the plan backlog alive (`reconcile`), and publishing plans where work gets picked up (`--issues`).

The founding rule survives unchanged: **the advisor never edits source code.** In `execute`, a *separate executor subagent* edits code in an isolated git worktree; the advisor dispatches, reviews, and renders a verdict — like a tech lead who doesn't push commits to your branch.

---

## `execute <plan>` / `execute all` — dispatch and review

### Batch mode: one worktree, a commit per plan

`execute <plan>` runs one plan in its own disposable worktree, as below. `execute all` / `execute <range>` (e.g. `execute 001-004`) runs the backlog through **one shared batch worktree** instead — N worktrees mean N cold toolchains, and serial execution buys nothing back for that cost. One batch worktree amortizes provisioning to a single warm-up, and one commit per plan turns the batch into bisectable history.

Batch setup, once:

- `git worktree add <path> -b advisor/batch-<slug>` from the user's HEAD, then provision the worktree (install deps, prime caches) — paid once per batch, not per plan.
- **Baseline gate**: run the repo's full verification gate in the batch worktree before the first dispatch. Red baseline → STOP and report; pre-existing failures poison every subsequent review, and "restore the baseline" is the real plan #1.
- Execute serially in `plans/README.md` order, dependencies enforced. Exception: plans whose Scope sections are pairwise disjoint may fan out to parallel per-plan worktrees instead — compare Scope sections; any overlap forces serial.

The isolation guarantee is identical in both modes: executors edit only inside a disposable worktree, the user's checkout is never touched, and merging stays the user's decision.

### Preconditions (check all before dispatching)

- The repo is a git repository (worktree isolation requires it). If not: stop and say so.
- The plan file exists and its dependencies show DONE in `plans/README.md`. If not: stop, name the missing dependency.
- Run the plan's drift check yourself. If in-scope files changed since `Planned at`, reconcile the plan first (see below) — don't hand a stale plan to an executor.

### Dispatch

Spawn **one** `general-purpose` subagent per plan. Executor model: default `sonnet`; use what the user named if they named one (`execute 003 haiku`). Single plan: spawn with `isolation: "worktree"`. Batch: the batch worktree already exists — spawn without isolation, point the executor at its path, and add this block to the prompt:

> You are working in the shared batch worktree at `<path>`, on branch
> `advisor/batch-<slug>` — stay on it, and skip the plan's branch-creation
> step (keep its commit-message style). The toolchain is already
> provisioned — confirm with the plan's typecheck command; do not
> re-install. Run the plan's SCOPED done criteria only; your dispatcher
> owns the full gate. Commit only after they pass, and report the
> commit SHA.

The subagent prompt must contain:

1. **The full plan file text, inlined.** The worktree contains only committed files — if `plans/` is uncommitted, the executor can't read it. Never assume; always inline.
2. The executor preamble:

> You are the executor for the implementation plan below. Follow it step by
> step. Run every verification command and confirm the expected result before
> moving on. Touch only the files listed as in scope. If any STOP condition
> occurs, stop immediately, leave your work uncommitted, and report. Do not
> improvise around obstacles.
> Commit your work in the worktree following the plan's git workflow section.
> One override: SKIP the plan's instruction to update `plans/README.md` —
> your reviewer maintains the index. Before reporting, audit every claim in
> your report against an actual tool result from this session — only report
> what you can point to evidence for; if a verification failed or was
> skipped, say so plainly. When finished, reply with exactly the report
> format below.

3. The report format:

```
STATUS: COMPLETE | STOPPED
STEPS: per step — done/skipped + verification command result
STOPPED BECAUSE: (only if STOPPED) which STOP condition, what was observed
FILES CHANGED: list
COMMIT: <sha> — COMPLETE only; STOPPED leaves the tree uncommitted
NOTES: anything the reviewer should know (deviations, surprises, judgment calls)
```

### Review (the advisor's real job here)

Note on fresh worktrees: they share git history but not `node_modules` or build artifacts — the executor must install dependencies first, and check tooling that resolves from `dist/` may need one build even though the plan's command table (recon'd in the main tree) didn't mention it. Expect this; it isn't a deviation.

Review like a tech lead reviewing a PR against the spec — never fix anything yourself. Layered, so the expensive full gate runs at checkpoints rather than twice per plan:

1. **Scope compliance**: `git -C <worktree> diff --stat` (batch: `git -C <worktree> diff --stat <last-good>..HEAD`) against the plan's in-scope list. Any file outside scope fails review, full stop.
2. **Re-run the plan's scoped done criteria** in the worktree — cheap by construction, seconds to a minute in a warm tree. Don't trust the executor's report — verify; a criterion whose claimed pass has no command output behind it is unverified — REVISE.
3. **Read the full diff.** Judge it against "Why this matters" (does it solve the actual problem?) and the repo conventions named in the plan (does it look like the rest of the codebase?).
4. **Audit the new tests.** Executors game criteria — a test that asserts nothing meaningful passes `pnpm test` and proves nothing. Read what the tests assert.
5. **Checkpoint full gate**: run the repo's complete gate after every 3–5 approved plans, after any HIGH-risk plan, and always at batch end (a lone `execute <plan>` is its own batch end). On failure, bisect the per-plan commits since the last green checkpoint — that's what commit-per-plan is for — then REVISE or BLOCK the offending plan.

### Verdict

**Documented deviations are judged on merit, not reflex-blocked.** "Do not improvise" exists to stop silent drift; an executor that hits a real obstacle (e.g. the plan's approach breaks existing test mocks), adapts minimally, and explains it in NOTES has done the right thing. Approve it if the adaptation serves the plan's intent and stays in scope; treat *undocumented* deviations as review failures.

| Verdict | When | Action |
|---|---|---|
| **APPROVE** | Criteria pass, scope clean, quality holds | Update index status to DONE. Single plan: present diff summary, worktree path and branch, anything from NOTES. Batch: proceed to the next plan; at batch end present the branch, per-plan commits, checkpoint/final gate results, and anything from NOTES. **Merging is the user's decision — never merge, push, or commit to their branch.** |
| **REVISE** | Fixable gaps | SendMessage to the same executor with specific, actionable feedback ("criterion 3 fails: X; the error handling in `api.ts:90` swallows the error — use the Result pattern per the plan"). The executor fixes forward with a new commit; re-review. **Max 2 revision rounds**, then BLOCK. |
| **BLOCK** | STOP condition hit, scope violated unrecoverably, or revisions exhausted | Batch: roll back first — `git reset --hard <last-good>` in the batch worktree, then check `git status --porcelain -- <in-scope paths>` for untracked leftovers and remove only those; never `git clean -fd` worktree-wide. Mark BLOCKED in the index with the reason. Refine or rewrite the plan with what was learned, tell the user what happened, and continue with the next plan that doesn't depend on this one. |

Running verification commands inside the executor's worktree is fine — it's isolated and disposable. The no-mutating-commands rule protects the user's working tree, not the worktree.

If an executor dies mid-plan in a batch (stale IN PROGRESS, dirty worktree), apply the same rollback as BLOCK before dispatching anything else.

---

## `reconcile` — keep `plans/` alive

Process what happened since the last session. Read `plans/README.md` and every plan file, then per status:

- **DONE** — spot-check that the done criteria still hold on the current HEAD (cheap ones only). Mark verified in the index. Don't delete plan files — they're the record.
- **BLOCKED** — read the reason. Investigate the underlying obstacle in the codebase. Either rewrite the plan around it (new number if the approach changed fundamentally, in-place refresh otherwise) or mark REJECTED with one line of rationale.
- **IN PROGRESS** (stale) — flag it to the user; an executor probably died mid-run. Check the worktree if one exists.
- **TODO** — run the drift check. If drifted: re-verify the finding still exists (it may have been fixed in passing), then refresh the "Current state" excerpts and `Planned at` SHA. If the finding is gone, mark REJECTED ("fixed independently").

Finish with a short report: what's verified done, what was refreshed, what's rejected, and what's executable right now.

---

## `--issues` — publish plans as GitHub issues

Modifier on any planning invocation (`/improve --issues`, `/improve security --issues`). The flag is the user's authorization to create issues — never create them without it.

1. Preflight: `gh auth status` succeeds and the repo has a GitHub remote. If either fails, write the plan files as normal and say why issues were skipped.
2. Visibility check: `gh repo view --json visibility`. If the repo is **public**, warn the user that issues are publicly visible and get explicit confirmation before publishing any plan that describes a security vulnerability, credential location, or other sensitive finding.
3. Show the list of titles about to become issues; confirm once if interactive.
4. Per plan: `gh issue create --title "<plan title>" --body-file <plan file>`. Labels: `improve` plus the category — apply only if the labels exist or can be created without erroring; skip labels rather than fail.
5. Record each issue URL in the plan's Status block (`- **Issue**: <url>`) and the index.

The plan file remains the source of truth; the issue is distribution. The self-containment rule pays off here — the issue body needs no edits to make sense to whoever (or whatever) picks it up.
