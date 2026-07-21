# OpenClaw Local Maintenance

This repo stores local maintenance documentation and scripts for the OpenClaw
installation on this Mac.

## Contents

- `docs/CLAUDE_OPENCLAW_MAINTENANCE_BRIEF.md`: briefing for Claude to build a
  local OpenClaw watchdog service.
- `docs/config/openclaw-2026.6.11-baseline.patch.json5`: documented baseline
  config patch for the current pinned OpenClaw setup. It references local secret
  files but does not contain secret values.
- `scripts/openclaw-cron/`: deterministic command-cron wrappers used to avoid
  fragile agent-turn cron behavior after OpenClaw upgrades.
