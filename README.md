[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/soedirman566-stack/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/soedirman566-stack/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` is one patch tool for every AI edit format. AI coding agents emit edits in incompatible dialects; mend reads any of them and applies the patch to a tree of text files:

- **unified diff** — `diff --git` sections and bare `---`/`+++` pairs, with hunks, creations, deletions, renames and moves, `\ No newline at end of file` handling, and prose around the diff ignored;
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks with the target path named above each block;
- **V4A** — `*** Begin Patch` … `*** End Patch` with Add / Delete / Update File sections, `*** Move to:`, `@@` anchors, a forward-only cursor, and `*** End of File` chunks;
- **JSON edits** — a JSON array or JSON Lines of `create`, `str_replace` and `insert` edit objects.

Each edit's old lines are located at the first of three matching tiers that fits — exact, then blind to trailing whitespace, then blind to leading whitespace too (with re-indentation of the replacement) — unless `--strict` pins matching to exact only. Edits apply in patch order, and application is atomic: if any edit fails, nothing is written and every failure is reported. mend prints one `A` / `D` / `M` / `R` line per changed file and a final `ok:` summary, with exit codes 0 (applied), 1 (some edit failed) and 2 (usage, format or parse error).

## Usage

```
node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read the patch from stdin. `--check` reports what would change without writing anything. The format is auto-detected when `--format` is not given.

Built for the [make.fun](https://make.fun) bounty "Build mend, one patch tool for every AI edit format" (hidden-spec-cli-01-run-20261122). Entry point: `main.ts`; `runner.ts` is the harness the entry hands over to.
