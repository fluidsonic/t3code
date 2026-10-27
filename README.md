# T3 Code (Marc) fork tooling

`fluidsonic/main` = upstream `main` + every `fork/<order>-<name>` branch on this fork, rebuilt by `fork-sync.ts`.

- `fork/10-pr-20145` tracks upstream PR #20145 and is dropped once it's merged or closed.
- `fork/10.1-<name>` is stacked on `fork/10-*`; `fork/20-<name>` is based on upstream `main`.
- `fork/01-upstream-fixes` carries fixes for upstream `main` breaking our checks; it drops itself once upstream has them.
- Add a topic by pushing a branch with that name; remove it by deleting the branch.

```sh
node fork-sync.ts            # sync, check, push, build a signed zip and publish it to feed/
node fork-sync.ts --dry-run  # sync and check only
node fork-sync.ts install    # install the newest feed build now, quitting and reopening the app
node fork-sync.ts serve      # serve feed/ on 127.0.0.1:47825 (the LaunchAgent runs this)
```

Each sync builds a newer `<version>-marc.<UTC minute>` and publishes it to `feed/`. The app checks that
feed every few minutes and offers to restart into the update, like the official app does. When the app
isn't running, the sync installs the build directly. Each build also gets a `fluidsonic/t3code` GitHub
release listing the upstream commits and changed fork topics since the previous release; the app shows
them as the update's release notes. Load the feed server once:

```sh
cp com.fluidsonic.t3marc.updates.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fluidsonic.t3marc.updates.plist
```

Its log is `~/Library/Logs/t3-code-marc-updates.log`.

macOS only accepts an update signed like the running app, so every build is signed with one local
self-signed identity in `signing.keychain-db`, which the first sync creates. Don't delete it: a build
signed with a new identity needs one `install` by hand.

The daily task resolves rebase conflicts itself in `~/Documents/t3-code-fork` and pushes the resolved
topic; `rerere` replays recorded resolutions. `known-test-failures.txt` lists tests that also fail on
upstream `main` on this Mac.
