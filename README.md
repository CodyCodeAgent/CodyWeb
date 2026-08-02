# CodyWeb

CodyWeb is a local-first web control surface for AI coding agents.

Today it supports **Codex only**. It runs a Node.js web server, starts and
bridges to the local Codex `app-server`, and gives you a browser-based
workspace for starting threads, supervising tool calls, reviewing diffs,
approving risky operations, and tracking local agent activity.

The project name is CodyWeb. The npm package and CLI command are
`cody-web-ui`.

The project is early but already aims at a larger shape: a practical,
auditable, browser-accessible engineering console for coding agents.

## Status

- Runtime support: Codex only.
- UI: browser-based desktop-style workspace.
- Storage: local SQLite via `better-sqlite3`.
- Network model: local web server with WebSocket updates.
- Maturity: active development; APIs and UI details may change.

Future versions may support additional agent runtimes, but this repository
currently assumes Codex semantics, Codex threads, and the Codex app-server
protocol.

## Features

- Browse Codex threads grouped by workspace.
- Create, resume, hide, restore, and inspect Codex threads without deleting or
  archiving the underlying Codex data.
- Stream assistant output, tool activity, approvals, and thread updates.
- Send text and local image inputs.
- Switch model, reasoning effort, and Codex collaboration mode.
- Review command and file-change approval requests.
- Inspect changed files and diff previews.
- Open a header work log for commands and file changes.
- Persist app preferences and the project/thread presentation catalog in local
  SQLite.
- Reconcile the local catalog on startup, from Codex events, and every 30
  seconds in the background.
- Schedule persistent Agent tasks from plain language or a form using one-time,
  interval, daily, weekly, monthly, workday, exclusion-date, or Cron plans.
- Apply persistent light/dark skins, accent colors, global density, and five
  workspace layout presets across Settings, conversations, and dashboards.
- Import, export, and share validated `.cody-skin` packages through the
  versioned [Skin API v1](docs/SKIN_API.md), including semantic component
  recipes and bounded local raster assets without executable skin code.
- View account rate limits and token usage.
- Use a configurable token flame widget for daily usage intensity.
- Protect remote browser access with a password by default.
- Use Feishu as another client for the same Codex threads: select a visible
  project, continue an existing Session or create a new one, then share the
  exact conversation and approval flow with the browser.

### Feishu bot client

Settings → Feishu bots creates a ready-to-use custom application with one
Feishu QR scan by default, while retaining App ID / Secret entry as a fallback.
Manual entry requires an explicit Feishu China or Lark International platform
choice so credentials are never probed against the wrong API domain.
CodyWeb uses the official SDK device flow: Feishu/Lark shows and confirms the
account, enterprise, least-privilege permissions, message event, and card
callback before returning write-only app credentials. CodyWeb then configures
and reads back the bot ability, WebSocket event/callback mode, published version,
availability, permissions, and bot identity before enabling the long connection.
The setup page persists and displays those results as a proof matrix, then runs
a fresh live OpenAPI/runtime diagnostic; it cannot report completion while any
proof remains unverified.
Private Web-console automation remains only as a recovery fallback. A private chat, flat group, or group topic can select a
visible CodyWeb project and an existing or new Codex Session. Feishu and the
browser then operate on the exact same `app-server` thread—CodyWeb does not
start a second CLI process or maintain a second transcript.

The client includes safe group trigger modes, identity and group-chat allow-lists,
signed least-privilege access-request cards, streamed cards, approvals and
user-input cards, commands, durable inbound deduplication,
FIFO turns shared with Web work, retry/dead-letter delivery, attachments, and
passive plus live connectivity diagnostics. See
[Feishu integration setup](docs/FEISHU_INTEGRATION.md) for
the exact permissions, deployment/security setup, REST rich-message handling,
and troubleshooting. The [botmux capability matrix](docs/FEISHU_BOTMUX_AUDIT.md)
records what was ported, adapted, and intentionally left outside CodyWeb's
app-server architecture.

### Agent task automation

Settings → Automation can create an Agent task from a custom instruction or a
saved prompt template. Each run creates a separate Codex thread so its context,
approval requests, token usage, and result remain independently auditable.

Task definitions, immutable definition versions, run timelines, delivery state,
and run history are stored in the CodyWeb SQLite database. The scheduler
recovers after service restarts, retries failures with bounded backoff, and
supports three explicit overlap policies: skip the new run, keep one queued
run, or cancel the old run and replace it. Active runs can be cancelled from
the UI.

Retries are tracked per scheduled run rather than across the lifetime of the
task. On restart, CodyWeb reads the associated Codex thread before deciding
whether an interrupted local scheduler record succeeded or failed. A SQLite
lease elects one scheduler when multiple CodyWeb Node processes share the
same settings database; run completion and delivery are committed once.

Safety controls include per-run time and token limits, automatic pause after a
configurable number of consecutive failures, and per-task notification rules.
Read-only access is the default. Workspace-write tasks remain sandboxed to the
selected workspace with network access disabled; actions that cross that
boundary surface through the normal approval center.

Results always remain in the independent Codex conversation. A task can also
append its result to a workspace-relative file, deliver it through configured
workspace notification/webhook channels, or do both. Settings → Automation
also supports task duplication, JSON import/export, definition rollback, and a
step-by-step run timeline.

Task workspaces are restricted to visible projects in the local catalog once
the catalog has been populated. Deleting a task archives its definition and
cancels pending queued runs while retaining versions and completed run history
for audit. The Archived view can restore a task in a paused state or permanently
delete its definition, versions, timeline, and run history after an explicit
confirmation. Batch imports are validated completely before any definition is
created. For daylight-saving transitions, nonexistent local times shift forward
by the DST gap and ambiguous times use the first occurrence.

When multiple CodyWeb processes share one settings database, manual queue and
replace requests are persisted in SQLite. The elected scheduler process performs
the actual Codex interrupt and replacement, so a request handled by a standby
web process cannot attempt to control a turn owned by another process.

## Requirements

- Node.js 18 or newer.
- npm.
- Codex CLI installed and available in `PATH`.

CodyWeb uses the npm package `better-sqlite3` for local settings. On common
platforms npm installs a prebuilt native binary. On less common platforms, npm
may need a working native build toolchain.

## Quick Start

Run directly:

```bash
npx cody-web-ui
```

Or install globally:

```bash
npm install -g cody-web-ui
cody-web-ui
```

By default the server listens on `127.0.0.1:3000` and prints a generated
password. Open the printed URL in a browser and sign in with that password.

## Production deployment script

The repository includes an idempotent deployment command that initializes
locked dependencies when needed, builds both bundles, stops the previously
managed process, and starts the new server in the background:

```bash
npm run deploy
```

The deploy command verifies that the running server reports the exact source
fingerprint it just built, including tracked edits and untracked files. This
prevents a dirty worktree from falsely passing verification merely because its
Git commit is unchanged. You can inspect the active build without signing in:

```bash
curl http://127.0.0.1:3000/codex-api/meta/version
```

Runtime state and logs are stored in `.cody-runtime/` by default. Configure the
listener through environment variables before deploying:

```bash
CODY_HOST=0.0.0.0 CODY_PORT=8080 CODY_PASSWORD='replace-me' npm run deploy
```

When a non-interactive SSH command starts the service, CodyWeb imports only
the standard proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
`NO_PROXY`, including lowercase variants) from the user's login shell if they
were not already provided. This keeps the Codex app-server network path aligned
with an interactive `codex` session. Set `CODY_IMPORT_LOGIN_PROXY_ENV=0` to
disable this behavior, or define the proxy variables explicitly in the service
environment.

`CODY_PASSWORD` is mandatory for non-loopback hosts. Service lifecycle commands
are also available independently:

Feishu management follows the same CodyWeb login boundary as the rest of the
control surface. It remains usable on authenticated HTTP deployments, matching
botmux's local-dashboard workflow, while the UI displays an unencrypted
transport warning. App Secrets are persisted server-side. Use an HTTPS reverse
proxy on shared or untrusted networks.

```bash
npm run service:status
npm run service:restart
npm run service:stop
bash scripts/cody-service.sh logs
```

The PID file is validated against this checkout's absolute CLI path before a
process is stopped, preventing a stale PID from terminating an unrelated
process. Override the runtime or log location with `CODY_RUNTIME_DIR` or
`CODY_LOG_FILE`.

## CLI Usage

```text
Usage: cody-web-ui [options]

Web interface for Codex app-server

Options:
  -p, --port <port>    port to listen on (default: "3000")
  --host <host>        host to listen on (default: "127.0.0.1")
  --password <pass>    set a specific password
  --no-password        disable password protection
  -h, --help           display help for command
```

Examples:

```bash
cody-web-ui
cody-web-ui --port 8080
cody-web-ui --host 0.0.0.0 --password my-secret
cody-web-ui --no-password
```

Use `--host 0.0.0.0` only on trusted networks or behind your own HTTPS,
authentication, and firewall controls. Browser access to CodyWeb can expose
local code, commands, credentials, and Codex capabilities.

## Production Deployment and File Permissions

Run CodyWeb as the same operating-system user that owns the Codex
configuration and the workspaces it manages. Do not start CodyWeb with
`sudo`: doing so can leave root-owned files inside a repository and make later
runs under a normal account fail.

CodyWeb and Codex need read and write access to the workspace and its Git
metadata. CodyWeb also creates automatic turn checkpoints under:

```text
<repository>/.git/cody-web-ui-checkpoints/
```

The runtime user must be able to create, read, update, and delete entries in
this directory. Checkpoints are CodyWeb recovery data rather than Git commits;
deleting them removes those recovery points but does not delete committed Git
history.

### Verify a workspace before starting the service

Set these values for your installation, then run the checks as the service
user:

```bash
CODY_USER=gouchao
REPO=/data00/home/gouchao/code/life-csr
CHECKPOINT_DIR="$REPO/.git/cody-web-ui-checkpoints"

sudo -u "$CODY_USER" test -r "$REPO"
sudo -u "$CODY_USER" test -w "$REPO"
sudo -u "$CODY_USER" test -w "$REPO/.git"
sudo -u "$CODY_USER" mkdir -p "$CHECKPOINT_DIR"
sudo -u "$CODY_USER" touch "$CHECKPOINT_DIR/.permission-check"
sudo -u "$CODY_USER" rm "$CHECKPOINT_DIR/.permission-check"
```

If a check fails, inspect every directory in the path instead of making the
whole repository world-writable:

```bash
namei -l "$CHECKPOINT_DIR"
find "$CHECKPOINT_DIR" ! -user "$CODY_USER" -ls | head -100
```

### systemd

Set `User=` and `Group=` explicitly. `HOME` and `PATH` must point to the same
user environment in which both `cody-web-ui` and `codex` are installed. For
example:

```ini
[Unit]
Description=CodyWeb
After=network.target

[Service]
Type=simple
User=gouchao
Group=gouchao
WorkingDirectory=/home/gouchao
Environment=HOME=/home/gouchao
Environment=PATH=/home/gouchao/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/cody-web-ui.env
ExecStart=/usr/bin/env cody-web-ui --host 127.0.0.1 --port 3000 --password ${CODY_WEB_UI_PASSWORD}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Store `CODY_WEB_UI_PASSWORD=...` in `/etc/cody-web-ui.env`, keep that file
root-owned with mode `600`, and replace all example users and paths. Before
enabling the unit, verify the binaries through the same account:

```bash
sudo -u gouchao env HOME=/home/gouchao PATH=/home/gouchao/.local/bin:/usr/local/bin:/usr/bin:/bin \
  sh -c 'command -v cody-web-ui && command -v codex'
```

If the unit uses filesystem-hardening options such as `ProtectHome=`,
`ReadOnlyPaths=`, or `ReadWritePaths=`, ensure every managed workspace and its
`.git` directory remains writable by the service.

### Containers and bind mounts

When running in a container, mount workspaces read-write and make the container
process UID/GID match the owner of the host files. Matching only the username
is not sufficient. A read-only mount or mismatched numeric UID/GID can produce
the same `EACCES` errors as incorrect host permissions.

### Repair an existing checkpoint directory

Stop CodyWeb before changing checkpoint ownership. If the service runs as
`gouchao`, repair the existing recovery data with:

```bash
CODY_USER=gouchao
CODY_GROUP="$(id -gn "$CODY_USER")"
REPO=/data00/home/gouchao/code/life-csr
CHECKPOINT_DIR="$REPO/.git/cody-web-ui-checkpoints"

sudo systemctl stop cody-web-ui
sudo chown -R "$CODY_USER:$CODY_GROUP" "$CHECKPOINT_DIR"
sudo chmod -R u+rwX "$CHECKPOINT_DIR"
sudo systemctl start cody-web-ui
```

If old CodyWeb recovery points are not needed, rebuilding the directory is
cleaner:

```bash
sudo systemctl stop cody-web-ui
sudo rm -rf -- "$CHECKPOINT_DIR"
sudo install -d -o "$CODY_USER" -g "$CODY_GROUP" -m 700 "$CHECKPOINT_DIR"
sudo systemctl start cody-web-ui
```

An `EACCES: permission denied, unlink ...` error usually means the runtime user
lacks write and execute permission on a parent directory. If ownership and mode
look correct, also inspect ACLs, immutable attributes, and mount flags:

```bash
getfacl "$CHECKPOINT_DIR"
lsattr -R "$CHECKPOINT_DIR" | head -100
mount | grep /data00
```

After upgrading an installation that was previously run as root or another
user, perform the workspace checks above before starting CodyWeb.

## Local Development

Install dependencies:

```bash
npm install
```

Start the Vite development server:

```bash
npm run dev
```

Run the built local server:

```bash
npm run build
npm start -- --no-password
```

Build the production frontend and CLI bundle:

```bash
npm run build
```

Run tests:

```bash
npm run verify
```

Useful targeted checks while developing:

```bash
npm test
npm run typecheck
npm test -- src/server/settingsStore.test.ts
npm test -- src/composables/useDesktopState.test.ts
git diff --check
```

`npm run verify` builds the app and runs the default non-token validation
suite: typecheck, unit tests, whitespace checks, packaged CLI smoke, Agent task
API lifecycle smoke, npm package dry-run smoke, controlled-process EPIPE survival smoke, approval center browser smoke, composer input smoke, Settings
theme persistence and visual-health smoke, empty thread lifecycle smoke, and
Work log browser smoke with panel/fullscreen visual-health checks. It also runs
the large-thread history, live-turn, and natural-approval smokes in their
default skip modes to confirm those opt-in checks are installed. It does
**not** start a real Codex turn, so it does not intentionally spend model
tokens.

Manual smoke checks before publishing or sharing a build:

- Run `npm run build && npm run smoke:cli` to verify the packaged CLI can
  start, serve the app shell, and answer the local meta API.
- Run `npm run smoke:controlled-process` after a build to make a bundled child
  process close stdin early, then verify the packaged CodyWeb server remains
  alive and continues answering health requests.
- Run `npm run smoke:package` after a build to verify `npm pack --dry-run`
  contains the expected `cody-web-ui` package name, CLI bin, built frontend,
  built CLI, README, license, smoke scripts, and no legacy package branding.
- Run `npm run smoke:approval` to browser-test the Approval Center: it enables
  smoke-only bridge hooks, injects a pending command approval, verifies the
  badge/card/actions render, clicks the Session action, and confirms the
  pending request is resolved.
- Run `npm run smoke:composer` to browser-test that the real composer input is
  enabled and the send button activates after typing, without sending to a
  model. To exercise the complete browser path against a real app-server turn,
  explicitly opt in with
  `CODY_WEB_UI_SMOKE_ALLOW_COMPOSER_TURN=1 npm run smoke:composer -- --require-live-render`.
  That mode creates a thread from the home composer, clicks Send, measures when
  the optimistic user bubble appears, verifies live deltas reach the DOM before
  `turn/completed`, waits for persistence, and reloads the page to assert the
  user message is still rendered exactly once.
- Run `npm run smoke:history` to confirm the opt-in large-thread browser smoke
  is installed. Give it a real thread with more than 80 rendered messages to
  verify the initial 80-message window, automatic top-scroll expansion, scroll
  anchor preservation, duplicate-free IDs, latest-message retention, and the
  reset window after a full reload:

  ```bash
  CODY_WEB_UI_SMOKE_HISTORY_THREAD_ID=<thread-id> npm run smoke:history
  ```

  This check reads an existing app-server thread and does not start a model
  turn or spend model tokens.
- Run `npm run smoke:catalog` to start CodyWeb with a temporary SQLite
  database, perform the first Codex catalog import, and verify project/thread
  hide and restore behavior without changing Codex archive state.
- Run `npm run smoke:theme` to browser-test Settings theme controls against a
  temporary SQLite settings database, clear browser storage, reload, verify the
  theme persisted through the server settings API, exercise all five layout
  presets and all three density modes, and verify both dark and light surfaces.
  The check also opens the centered new-thread page to confirm global spacing,
  composer alignment, theme colors, and overflow behavior rather than
  validating only the Settings controls.
- Run `npm run smoke:thread` to verify the real app-server thread lifecycle:
  create an empty thread and read it back. Empty app-server threads can be
  readable before they appear in `thread/list` or accept archive cleanup because
  they may not have a materialized rollout yet; CodyWeb keeps newly created
  threads visible in the UI with an optimistic local row while the first turn is
  starting. Add `--require-listed` or set
  `CODY_WEB_UI_SMOKE_REQUIRE_THREAD_LIST=1` when you specifically want to
  diagnose app-server list materialization.
- Run `npm run smoke:turn` to confirm the opt-in turn smoke is installed. By
  default it skips without starting a model turn.
- Run `npm run smoke:turn-approval` to confirm the opt-in natural approval
  smoke is installed. By default it skips without starting a model turn.
- Run `npm run smoke:worklog` to let CodyWeb find a recent real Codex thread
  with file changes and browser-test the header Work log badge, panel layout,
  file search, fullscreen diff, split/unified switching, and populated desktop
  screenshots. Use `npm run smoke:worklog -- --thread-id <id>` when you want a
  deterministic thread fixture. Add `--require-diff` or set
  `CODY_WEB_UI_SMOKE_REQUIRE_WORKLOG=1` when this check should fail instead of
  skipping if no real diff thread is available.
- Real `turn/start` message submission is intentionally not part of the default
  smoke suite because it starts an actual Codex turn and can consume model
  tokens. To explicitly verify a live model response end to end, run:

  ```bash
  CODY_WEB_UI_SMOKE_ALLOW_TURN=1 npm run smoke:turn
  ```

  The opt-in smoke connects to `/codex-api/ws` before sending the turn and
  reports realtime lifecycle and live-delta evidence after the response lands.
  It tolerates the short empty-rollout window that can appear immediately after
  `turn/start` before the app-server has written readable thread content.
  You can pass `-- --cwd <path> --message <prompt> --model <model>
  --effort <effort> --timeout-ms <ms> --require-live-delta` to customize that
  opt-in smoke and make live assistant/plan/reasoning delta frames mandatory.
- To verify the same live response through the actual browser composer and
  rendered conversation, run:

  ```bash
  CODY_WEB_UI_SMOKE_ALLOW_COMPOSER_TURN=1 npm run smoke:composer -- --require-live-render
  ```

  This browser variant covers home-page thread creation, the optimistic user
  message, route transition, live assistant rendering, completed persistence,
  and duplicate-free rendering before and after a full page reload. Pass
  `-- --message <prompt> --timeout-ms <ms>` to customize the turn.
- Natural command approval is also intentionally opt-in because it starts a
  real Codex turn and depends on the model choosing to execute the requested
  command. To diagnose whether a genuine app-server
  `item/commandExecution/requestApproval` reaches the bridge and can be
  resolved, run:

  ```bash
  CODY_WEB_UI_SMOKE_ALLOW_TURN_APPROVAL=1 npm run smoke:turn-approval
  ```

  The smoke asks Codex to run a harmless command, waits for the natural pending
  approval request, responds with `decline`, verifies the pending request is
  cleared, and archives the created thread best-effort. It starts the diagnostic
  turn with `approvalPolicy: "untrusted"` and a read-only sandbox override, but
  the check is still not deterministic: if the model answers without actually
  invoking command execution, no approval request exists for CodyWeb to render.
  Use `npm run smoke:approval` as the deterministic browser regression for the
  approval UI, bridge pending queue, and response path.
- Start the built server with `npm start -- --no-password`.
- Open a Codex thread that contains file changes and verify the header Work log
  badge matches the changed-file count.
- Open the Work log panel and verify changed files, line counts, diff preview,
  and fullscreen diff still render.
- Open Settings, change skin, density, layout, and accent, then reload and
  verify the selected theme persists.

## Architecture

CodyWeb has three main layers:

- **Frontend**: Vue, Vite, and TypeScript. The UI lives under `src/components`
  and `src/composables`.
- **Local web server**: Node.js and Express. The server lives under
  `src/server` and handles static assets, authentication, WebSocket updates,
  file/image helpers, local settings, the project/thread catalog, background
  reconciliation, and the Codex bridge.
- **Codex bridge**: a Node-side bridge that starts `codex app-server`, proxies
  JSON-RPC requests, and normalizes app-server notifications for the UI.

Local settings and catalog presentation state are stored in:

```text
~/.cody-web-ui/settings.sqlite3
```

You can override that path with:

```bash
CODY_WEB_UI_SETTINGS_DB=/path/to/settings.sqlite3 cody-web-ui
```

## Documentation

- [Final product vision](docs/FINAL_PRODUCT_VISION.md)
- [Codex app-server protocol notes](documentation/APP_SERVER_DOCUMENTATION.md)
- [App-server schema usage guide](documentation/APP_SERVER_SCHEMA_USAGE.md)
- [Local project and thread catalog](documentation/LOCAL_CATALOG.md)

The generated app-server schemas live under:

```text
documentation/app-server-schemas/
```

Do not edit generated schema files by hand.

## Current Limitations

- Only Codex is supported.
- The app-server protocol is still evolving, so some integrations may require
  schema updates.
- The UI is optimized for trusted local or private-network use, not public
  internet exposure.
- Some features depend on Codex app-server capabilities that may differ across
  Codex versions.

## Contributing

Contributions are welcome. For protocol-facing work, read
[APP_SERVER_SCHEMA_USAGE.md](documentation/APP_SERVER_SCHEMA_USAGE.md) before
changing request or notification payloads.

Please keep changes focused, add tests for behavior that crosses the app-server
boundary, and run:

```bash
npm run verify
```

## License

[MIT](./LICENSE)
