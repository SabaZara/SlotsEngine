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
