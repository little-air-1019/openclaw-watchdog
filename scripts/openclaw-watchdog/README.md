# OpenClaw Watchdog

Local daily maintenance watchdog for this Mac. It runs OpenClaw health checks, records JSONL logs, creates backups before repair, and applies only the safe repair commands from `docs/CLAUDE_OPENCLAW_MAINTENANCE_BRIEF.md`.

## Commands

```bash
scripts/openclaw-watchdog/openclaw-watchdog check
scripts/openclaw-watchdog/openclaw-watchdog repair
scripts/openclaw-watchdog/openclaw-watchdog once
scripts/openclaw-watchdog/openclaw-watchdog install
scripts/openclaw-watchdog/openclaw-watchdog uninstall
scripts/openclaw-watchdog/openclaw-watchdog status
```

`check` is read-only. `once` runs `check`, repairs when unhealthy or suspicious, then verifies. `repair` always creates a timestamped backup first.

## Runtime Files

- Logs: `logs/openclaw-watchdog/YYYY-MM-DD.jsonl`
- Backups: `backups/openclaw-watchdog/<timestamp>/`
- LaunchAgent: `~/Library/LaunchAgents/ai.openclaw.watchdog.plist`

## Install

```bash
scripts/openclaw-watchdog/openclaw-watchdog once
scripts/openclaw-watchdog/openclaw-watchdog install
scripts/openclaw-watchdog/openclaw-watchdog status
```

The LaunchAgent runs at login and once per day at 08:10 Asia/Taipei.

## Safety

The watchdog does not run OpenClaw updates, npm global updates, downgrades, direct SQLite edits, state deletion, or Discord/LINE alerts. Downgrade remains disabled unless a local `watchdog.config.json` explicitly sets `allowDowngrade` to `true`; this first version still only logs the policy and does not implement downgrade.

To change the pinned baseline, copy `watchdog.config.example.json` to `watchdog.config.json` and update `expectedVersion`.
