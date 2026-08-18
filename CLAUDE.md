# Working on this repo

## Consult the reference repo before starting any work

This project is a response to a review of a larger existing codebase. Both
that codebase and the review documents are on disk. **Read the relevant
part before writing code — not after, and not only when stuck.**

| What | Where |
|---|---|
| Reference codebase | `~/Desktop/irakli/slot-engine` — [backdoor-ge/slot-engine](https://github.com/backdoor-ge/slot-engine) @ `c3b93d3` |
| Full repository review | `~/Desktop/irakli/review-docs/full-repo-review.md` |
| Review brief | `~/Desktop/irakli/review-docs/slot-engine-review-brief.md` |
| Paytable audit | `~/Desktop/irakli/slot-engine-paytable-audit.txt` |
| Study guide | `~/Desktop/irakli/slot-engine-study-guide.txt` |

Every mention of "the review" in `README.md` and `docs/TODO.md` points at
those documents.

**Before touching a module**, look for its counterpart:

```bash
find ~/Desktop/irakli/slot-engine -path '*<name>*' -not -path '*/node_modules/*' -not -path '*/dist/*'
```

If it has tests, read them first and ask what they cover that a fresh
attempt would miss. Check the review for a finding on it — several are
already closed here, so do not "fix" what is fixed.

**Adapt, never transplant.** The codebases differ in real ways: different
payline win rule (`sum` here, full-length-only there), different collection
names, different module layout. Code that compiles is not code that is
correct here.

`docs/TODO.md` has the longer version of this, including what skipping it
already cost (F14, and the independent model cross-check).

## Verification standard

The bar in this repo is higher than "tests pass", because several real bugs
here passed a green suite. In order of how much they establish:

1. **Mutation-verify.** Break the code deliberately and confirm the test
   fails. A test never observed failing has established nothing. If a
   mutation survives, say so and explain why — an equivalent mutant is a
   fine answer, silence is not.
2. **Run it against the real stack.** The in-memory `fakeMongo` models no
   schema validator and no rollback, and has hidden real bugs twice (F1,
   F9). A money-path or schema change is not verified until it has run
   against the live services.
3. **Say what a test cannot establish.** Every suite here that has a known
   blind spot states it in the file header. Follow that.
4. **Clone what you pushed.** Before treating a push as done:

   ```bash
   git clone <remote> /tmp/clonecheck && cd /tmp/clonecheck && npm install && npm run build && npm test
   ```

   The three checks above all run against the **working tree**, so none of
   them can see a file that is missing from the *repository*. F29 is why
   this is here: a `.gitignore` rule of bare `reports/` matched at every
   depth and silently excluded a whole source module from the commit that
   shipped its import. The suite, the build and the pre-push hook all
   passed, and `main` could not build on a clean checkout. A clone is the
   only check that runs against what other people will actually get.

   Worth reading a commit's own diffstat for the same reason — "2 files
   changed" where it should say 8 is what exposed F29.

## Conventions

- **Comments explain *why*, not what.** The existing code is dense with
  reasoning about rejected alternatives; match that register. A comment
  restating the code is noise.
- **Tests are named as claims**, not as method names: "refuses to overdraw,
  leaving the balance untouched", not "test debit 2".
- **`docs/TODO.md` is the working log.** Fixed items become an `F` row
  recording *how it was found*, not just what changed. Open items record
  the reasoning, including deliberate non-decisions.
- **Money is always integer minor units.** Never a float, anywhere.
- Commit messages explain the reasoning and name what was verified. End
  with the `Co-Authored-By` trailer.

## Branch, then PR — never commit straight to `main`

Work on a branch and open a pull request. `main` is for merged work only.

This is written down because it was not followed: a run of changes went
directly to `main` — including a new dependency and a change to the only
browser-facing route — each pushed the moment CI went green, so there was
never a point at which anyone could have looked before it landed. The work
was verified and the work was fine; that is not the issue. **A review point
you can skip is not a review point**, and there is no branch protection
here to enforce one (item 2 in `docs/TODO.md`, waiting on a paid plan), so
the discipline has to live here instead.

```bash
git switch -c <short-descriptive-name>
# ... work, commit as normal ...
git push -u origin <name>
gh pr create --fill
```

Then **stop, and let a human merge it** unless they have said otherwise.
Reporting "the PR is open and CI is green" is finishing the task; merging
it yourself is deciding on someone else's behalf that it was ready.

Delete the branch after it merges. A merged branch left behind becomes a
stale pointer nobody can tell from live work — `artwork-path` sat 44
commits behind `main` for exactly that reason.
