# T3 Marc fork tooling

`fluidsonic/main` = upstream `main` + every `fork/<order>-<name>` branch on this fork, rebuilt by `fork-sync.ts`.

- `fork/10-pr-20145` tracks upstream PR #20145 and is dropped once it's merged or closed.
- `fork/10.1-<name>` is stacked on `fork/10-*`; `fork/20-<name>` is based on upstream `main`.
- Add a topic by pushing a branch with that name; remove it by deleting the branch.

```sh
node fork-sync.ts            # sync, check, push, build release/*.dmg in ~/Documents/t3-code-fork
node fork-sync.ts --dry-run  # sync and check only
node fork-sync.ts install    # install the newest build as /Applications/T3 Marc.app
```

Conflicts are resolved once by hand in `~/Documents/t3-code-fork`; `rerere` replays them after that.
`known-test-failures.txt` lists tests that also fail on upstream `main` on this Mac.
