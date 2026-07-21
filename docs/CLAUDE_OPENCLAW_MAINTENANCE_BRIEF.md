# Claude Brief: OpenClaw Maintenance Watchdog

This document is for Claude. It explains what OpenClaw is, where to read the official docs, what is installed on this Mac, and what service you should implement.

## Why This Exists

OpenClaw has broken on this machine after accidental upgrades. The owner wants a local always-on service that checks OpenClaw every day and can repair common post-upgrade breakage automatically. Do not assume you already know OpenClaw. Treat the links below as the source of truth and verify behavior against the installed CLI.

## Official OpenClaw References

- Official site: https://openclaw.ai/
- Official docs: https://docs.openclaw.ai/
- GitHub: https://github.com/openclaw/openclaw
- Releases: https://github.com/openclaw/openclaw/releases
- Discord/community: https://discord.com/invite/openclaw
- Foundation/project site: https://openclaw.org/

Start with these docs:

- Overview: https://docs.openclaw.ai/
- Install: https://docs.openclaw.ai/install
- Gateway runbook: https://docs.openclaw.ai/gateway
- CLI reference: https://docs.openclaw.ai/cli
- Cron CLI: https://docs.openclaw.ai/cli/cron
- Doctor CLI: https://docs.openclaw.ai/cli/doctor
- Status CLI: https://docs.openclaw.ai/cli/status
- Update CLI: https://docs.openclaw.ai/cli/update
- Troubleshooting: https://docs.openclaw.ai/troubleshooting
- FAQ: https://docs.openclaw.ai/faq

Useful facts from the docs:

- OpenClaw is a self-hosted Gateway that connects chat apps such as Discord, Slack, Telegram, WhatsApp, Signal, Matrix, Microsoft Teams, iMessage, and others to AI coding agents.
- The Gateway is the always-on process. It owns routing, channel connections, sessions, control/RPC, HTTP API compatibility endpoints, and the Control UI.
- The default local dashboard is `http://127.0.0.1:18789/`.
- Default config is `~/.openclaw/openclaw.json`.
- The core CLI entry point is `openclaw`.
- Important health commands:
  - `openclaw --version`
  - `openclaw status`
  - `openclaw status --deep`
  - `openclaw gateway status`
  - `openclaw gateway status --deep`
  - `openclaw config validate`
  - `openclaw models status`
  - `openclaw cron status --json`
  - `openclaw doctor --lint --json`
  - `openclaw doctor --post-upgrade --json`
- Important repair commands:
  - `openclaw doctor --fix --non-interactive`
  - `openclaw gateway restart`
  - `openclaw gateway install --force`
  - `openclaw secrets reload`
  - `openclaw doctor --state-sqlite compact --json`
- Cron jobs now live in the shared sqlite state DB, not the old JSON store. Use `openclaw cron add|edit|rm|run|runs|status`, not manual edits to `~/.openclaw/cron/jobs.json`.
- Command cron jobs are preferred for deterministic maintenance because they run directly in the Gateway process and do not depend on an isolated agent turn or model-visible `tools.exec`.

## Current Machine State

Host project/workspace:

- Repo for local OpenClaw maintenance files: `/Users/twipc00907426/orca/projects/openclaw`
- Existing local scripts: `/Users/twipc00907426/orca/projects/openclaw/scripts/openclaw-cron/`

Installed OpenClaw:

- Current version when this brief was written: `OpenClaw 2026.6.11 (e085fa1)`
- Install kind: npm package
- OpenClaw package root: `/Users/twipc00907426/.nvm/versions/node/v22.22.3/lib/node_modules/openclaw`
- Config: `~/.openclaw/openclaw.json`
- Gateway: `ws://127.0.0.1:18789`
- Dashboard: `http://127.0.0.1:18789/`
- Gateway service: macOS LaunchAgent, installed and running
- Node: `22.22.3`
- OS: macOS arm64
- Update channel: `stable`
- Default model: `openai/gpt-5.5`
- Agent dir: `~/.openclaw/agents/main/agent`
- Cron storage: sqlite at `~/.openclaw/state/openclaw.sqlite`
- Cron jobs count when this brief was written: `22`

Important previous incident:

- After an OpenClaw upgrade, several cron jobs still used old `agentTurn` payloads. They failed because isolated agent runs did not reliably expose shell/gh/gog/file tools.
- Known fix pattern: convert fragile cron jobs to deterministic `payload.kind: "command"` jobs with exact `--command-argv`, explicit cwd, timeout, and output limits.
- Existing wrapper examples:
  - `scripts/openclaw-cron/ida-attendance-report.js`
  - `scripts/openclaw-cron/claude-code-usage-report.js`

## Your Task

Implement a local always-on maintenance service for this Mac.

Service goals:

1. Run every day.
2. Check OpenClaw health.
3. Detect accidental upgrades or post-upgrade breakage.
4. Repair safe/common breakage automatically.
5. Log every check and repair.
6. Avoid leaking secrets.
7. Never make destructive changes without a local backup.

Preferred location:

- Put implementation under `/Users/twipc00907426/orca/projects/openclaw/scripts/openclaw-watchdog/`.
- Put logs under `/Users/twipc00907426/orca/projects/openclaw/logs/openclaw-watchdog/`.
- Put backups under `/Users/twipc00907426/orca/projects/openclaw/backups/openclaw-watchdog/`.

Preferred runtime:

- Use Node.js or shell. Node.js is preferred because parsing JSON and writing structured logs is easier.
- Run as the normal user `twipc00907426`, not as root and not from a restricted sandbox.
- Install as a macOS LaunchAgent so it continues to run locally.

## Required Service Behavior

The service should support at least these commands:

```bash
openclaw-watchdog check
openclaw-watchdog repair
openclaw-watchdog once
openclaw-watchdog install
openclaw-watchdog uninstall
openclaw-watchdog status
```

Suggested semantics:

- `check`: read-only health check; exit non-zero if unhealthy.
- `repair`: run safe repair flow; exit non-zero if still unhealthy.
- `once`: run `check`; if unhealthy or suspicious, run `repair`; then run `check` again.
- `install`: create or update the LaunchAgent plist.
- `uninstall`: unload and remove this watchdog LaunchAgent only.
- `status`: show recent log summary and LaunchAgent state.

Daily schedule:

- Run once per day, for example at `08:10 Asia/Taipei`.
- Also run at login/startup.
- Do not run in a tight loop. This is a daily watchdog, not a hot path monitor.

## Health Checks

Run these in order and capture stdout/stderr:

```bash
openclaw --version
openclaw config validate
openclaw gateway status
openclaw status
openclaw models status
openclaw cron status --json
openclaw doctor --lint --json
openclaw doctor --post-upgrade --json
```

Use deeper checks when something looks wrong:

```bash
openclaw gateway status --deep
openclaw status --deep
openclaw doctor --deep
```

Expected baseline:

- Version should stay at `2026.6.11` unless the owner intentionally changes the baseline.
- Gateway should be reachable on `127.0.0.1:18789`.
- Config should validate.
- Models should report default `openai/gpt-5.5` and usable runtime auth.
- Cron should report sqlite storage and a nonzero job count.
- Known security warnings about open Discord/LINE policy may exist. Log them, but do not treat them as upgrade breakage unless they are new fatal errors.

## Repair Flow

Before any repair:

1. Create a timestamped backup directory.
2. Copy these files/directories if they exist:
   - `~/.openclaw/openclaw.json`
   - `~/.openclaw/state/openclaw.sqlite`
   - `~/.openclaw/state/openclaw.sqlite-wal`
   - `~/.openclaw/state/openclaw.sqlite-shm`
   - `~/.openclaw/agents/main/sessions/sessions.json`
3. Record command outputs and the detected failure reason.

Safe repair sequence:

```bash
openclaw doctor --fix --non-interactive
openclaw doctor --state-sqlite compact --json
openclaw secrets reload
openclaw gateway restart
openclaw config validate
openclaw gateway status
openclaw status
openclaw models status
openclaw cron status --json
openclaw doctor --post-upgrade --json
```

If the Gateway service is missing or points to the wrong port:

```bash
openclaw gateway install --force
openclaw gateway restart
```

If a command says the sqlite DB is read-only:

- First confirm the service is not running from a sandbox.
- Check file ownership and mode for `~/.openclaw/state` and `~/.openclaw/state/openclaw.sqlite*`.
- Do not chmod/chown blindly. Log findings and only repair ownership/mode if the files are owned by the current user and the fix is clearly safe.

If accidental upgrade is detected:

- Do not automatically downgrade unless the owner explicitly approves that policy.
- First run the post-upgrade repair flow above.
- If the installed version differs from the pinned baseline and health checks fail, record the mismatch and produce a clear alert/log entry.
- If you implement downgrade/pin repair, make it opt-in via a config file such as `watchdog.config.json`, with `allowDowngrade: true` required.

## Cron-Specific Checks

Use:

```bash
openclaw cron status --json
openclaw cron list --json
```

Check for:

- `storage` should be `sqlite`.
- `sqlitePath` should be `~/.openclaw/state/openclaw.sqlite`.
- Important command cron jobs should still have `payload.kind: "command"`.
- Old fragile jobs that depend on shell/file/calendar/GitHub operations should not be converted back to `agentTurn`.

Known important jobs:

- `195d1801-3b72-41f7-b38a-1a2cecc2a0aa` Story point auto-estimate: should be command cron.
- `c6f9b80c-9efc-40f2-8bcf-90cc039db0bb` IDA weekday GitHub work summary: should be command cron.
- `699319bb-eada-40ad-b35e-7a9cd6108a51` IDA attendance report: should be command cron using `scripts/openclaw-cron/ida-attendance-report.js`.
- `684491b6-a030-43dd-a3d3-4b7ea91cf3c6` Claude Code usage report: should be command cron using `scripts/openclaw-cron/claude-code-usage-report.js`.

Do not edit the sqlite DB directly. Use `openclaw cron edit`.

## Logging and Alerts

Write structured JSONL logs:

```text
logs/openclaw-watchdog/YYYY-MM-DD.jsonl
```

Each record should include:

- timestamp
- phase: `check`, `repair`, `verify`, `install`, `uninstall`
- command
- exit code
- duration ms
- stdout/stderr snippets with secrets redacted
- decision made

Redact:

- Gateway auth token
- Discord token
- LINE token
- GitHub token
- OAuth credentials
- Any value read from `*.secret`

Do not post to Discord/LINE until the owner explicitly asks. Local logs are enough for the first version.

## Implementation Constraints

- Do not run `openclaw update` automatically.
- Do not run `npm install -g openclaw@latest` automatically.
- Do not delete OpenClaw state.
- Do not edit `~/.openclaw/openclaw.json` manually unless the exact change is backed up and justified.
- Do not mutate cron sqlite directly.
- Do not expose tokens in logs, command output, exceptions, or process arguments.
- Prefer `openclaw doctor --lint --json` for read-only automated decisions.
- Prefer `openclaw doctor --fix --non-interactive` for safe repairs.
- Treat docs as current, but verify installed CLI behavior with `--help` because this machine may stay pinned.

## Acceptance Criteria

The first version is done when:

1. `openclaw-watchdog once` runs successfully on this machine.
2. A LaunchAgent plist exists and is loaded for daily execution.
3. Logs are written under `logs/openclaw-watchdog/`.
4. Backups are created before repair mode mutates anything.
5. The service can detect:
   - Gateway unreachable
   - config invalid
   - model auth unusable
   - cron storage not sqlite
   - important cron jobs reverted from command to agentTurn
   - installed OpenClaw version differs from baseline
6. The service can safely attempt:
   - `doctor --fix --non-interactive`
   - sqlite compact
   - secrets reload
   - gateway restart
   - gateway service reinstall only when service is missing or wrong
7. After repair, it reruns checks and exits non-zero if OpenClaw remains unhealthy.

## Suggested First Steps for Claude

1. Read this whole file.
2. Open the official docs linked above, especially Gateway, Cron, Doctor, Status, and Update.
3. Run these locally:

```bash
cd /Users/twipc00907426/orca/projects/openclaw
openclaw --version
openclaw status
openclaw config validate
openclaw cron status --json
openclaw doctor --lint --json
openclaw cron list --json
```

4. Inspect existing scripts:

```bash
ls -la scripts/openclaw-cron
```

5. Implement `scripts/openclaw-watchdog/openclaw-watchdog.js`.
6. Add `scripts/openclaw-watchdog/README.md` documenting install/uninstall and recovery behavior.
7. Test with `node scripts/openclaw-watchdog/openclaw-watchdog.js once`.
8. Install the LaunchAgent only after the one-shot test is clean.
