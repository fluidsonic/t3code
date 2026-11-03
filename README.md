# T3 Code (Marc) fork tooling

`fluidsonic/main` = upstream `main` + every `fork/<order>-<name>` branch on this fork, rebuilt by `fork-sync.ts`.

- `fork/10-pr-20145` tracks upstream PR #20145 and is dropped once it's merged or closed.
- `fork/10.1-<name>` is stacked on `fork/10-*`; `fork/20-<name>` is based on upstream `main`.
- `fork/01-upstream-fixes` carries fixes for upstream `main` breaking our checks; it drops itself once upstream has them.
- Add a topic by pushing a branch with that name; remove it by deleting the branch.

```sh
node fork-sync.ts            # sync, check, push, build, and release on fluidsonic/t3code
node fork-sync.ts --dry-run  # sync and check only
node fork-sync.ts install    # install the newest local build now, quitting and reopening the app
```

Each sync builds a newer `<version>-marc.<UTC minute>` and creates a `fluidsonic/t3code` GitHub release
with its zip, a dmg, and `latest-mac.yml`, listing the upstream commits and changed fork topics since
the previous release. The app on any Mac checks the latest release every few minutes and offers to
restart into it, like the official app does. When the app isn't running here, the sync installs the
build directly. `feed/` keeps the last two builds locally.

To install on another Mac, open the dmg from the latest release and drag the app to Applications. The
app isn't notarized, so the first launch needs Open Anyway in System Settings > Privacy & Security.

macOS only accepts an update signed like the running app, so every build is signed with one
self-signed identity in `signing.keychain-db`, which the first sync creates. Don't delete it, and
copy it to any other Mac that runs the sync: a build signed with another identity doesn't install as
an update anywhere, and each Mac then needs one install by hand.

Builds from before the GitHub feed read their updates from `127.0.0.1:47825`; `serve` (run by
`com.fluidsonic.t3marc.updates.plist`) keeps that working until the app has updated once. Then unload it:

```sh
launchctl bootout gui/$(id -u)/com.fluidsonic.t3marc.updates
rm ~/Library/LaunchAgents/com.fluidsonic.t3marc.updates.plist
```

The daily task resolves rebase conflicts itself in `~/Documents/t3-code-fork` and pushes the resolved
topic; `rerere` replays recorded resolutions. `known-test-failures.txt` lists tests that also fail on
upstream `main` on this Mac.
