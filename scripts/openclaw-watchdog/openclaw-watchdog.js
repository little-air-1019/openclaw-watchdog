#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'logs', 'openclaw-watchdog');
const BACKUP_ROOT = path.join(REPO_ROOT, 'backups', 'openclaw-watchdog');
const STATE_DIR = path.join(REPO_ROOT, '.state', 'openclaw-watchdog');
const LOCK_DIR = path.join(STATE_DIR, 'run.lock');
const ALERT_STATE_PATH = path.join(STATE_DIR, 'alerts.json');
const CONFIG_PATH = path.join(__dirname, 'watchdog.config.json');
const LABEL = 'ai.openclaw.watchdog';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DEFAULT_EXPECTED_VERSION = '2026.6.11';
const DEFAULT_GATEWAY_PORT = 18789;
const TIMEOUT_MS = 120_000;
const SNIPPET_BYTES = 6000;

const IMPORTANT_COMMAND_JOBS = new Map([
  ['195d1801-3b72-41f7-b38a-1a2cecc2a0aa', 'Story point auto-estimate'],
  ['c6f9b80c-9efc-40f2-8bcf-90cc039db0bb', 'IDA weekday GitHub work summary'],
  ['699319bb-eada-40ad-b35e-7a9cd6108a51', 'IDA attendance report'],
  ['684491b6-a030-43dd-a3d3-4b7ea91cf3c6', 'Claude Code usage report'],
]);

const DEFAULT_CONFIG = {
  expectedVersion: DEFAULT_EXPECTED_VERSION,
  gatewayPort: DEFAULT_GATEWAY_PORT,
  allowDowngrade: false,
  openclawBin: process.env.OPENCLAW_BIN || 'openclaw',
  discordWebhookUrl: process.env.OPENCLAW_WATCHDOG_DISCORD_WEBHOOK_URL || '',
  discordWebhookUrlFile: '',
  alertCooldownHours: 23,
  modelAuthExpiryNoticeHours: 24,
  alertOnWarnings: ['model_auth_expiring', 'version_mismatch'],
};

function ensureDirs() {
  for (const dir of [LOG_DIR, BACKUP_ROOT, STATE_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (error) {
    return { ...DEFAULT_CONFIG, configError: `Invalid JSON in ${CONFIG_PATH}: ${error.message}` };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function localDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function logPath() {
  return path.join(LOG_DIR, `${localDay()}.jsonl`);
}

function redact(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/token config \([^)]*\)/gi, 'token config (<redacted>)');
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '<redacted>');
  out = out.replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi, '$1<redacted>');
  out = out.replace(/((?:gateway|discord|line|github|oauth|access|refresh|id)_?(?:auth)?_?(?:token|secret|password|key)\s*[:=]\s*)["']?[^"',\s]+/gi, '$1<redacted>');
  out = out.replace(/(OPENCLAW_GATEWAY_TOKEN|DISCORD_[A-Z_]*TOKEN|LINE_[A-Z_]*TOKEN|GH_TOKEN|GITHUB_TOKEN)=["']?[^"'\s]+/g, '$1=<redacted>');
  out = out.replace(/\$\([^)]*(?:\.secret|token|TOKEN)[^)]*\)/g, '$(<redacted>)');
  out = out.replace(/(https:\/\/discord(?:app)?\.com\/api\/webhooks\/)[^\s"']+/gi, '$1<redacted>');
  return out;
}

function snippet(text) {
  const clean = redact(text);
  return clean.length > SNIPPET_BYTES ? `${clean.slice(0, SNIPPET_BYTES)}...<truncated>` : clean;
}

function writeLog(record) {
  ensureDirs();
  fs.appendFileSync(logPath(), `${JSON.stringify({ timestamp: nowIso(), ...record })}\n`);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^~(?=$|\/)/, os.homedir());
}

function runCommand(argv, options = {}) {
  const started = Date.now();
  const cmd = argv.join(' ');
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd || REPO_ROOT,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, options.timeoutMs || TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { stderr += `${error.message}\n`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command: cmd,
        argv,
        exitCode: timedOut ? 124 : (code ?? 1),
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function recordCommand(phase, argv, decision, options = {}) {
  const result = await runCommand(argv, options);
  const stdout = options.logStdout ? options.logStdout(result) : result.stdout;
  const stderr = options.logStderr ? options.logStderr(result) : result.stderr;
  writeLog({
    phase,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: snippet(stdout),
    stderr: snippet(stderr),
    decision,
  });
  return result;
}

function parseJson(result) {
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

function addIssue(issues, id, severity, message, data = {}) {
  issues.push({ id, severity, message, ...data });
}

function errorIssues(summary) {
  return summary.issues.filter((issue) => issue.severity === 'error');
}

function alertableIssues(summary, config) {
  const warningIds = new Set(config.alertOnWarnings || []);
  return summary.issues.filter((issue) => issue.severity === 'error' || warningIds.has(issue.id));
}

function shouldRepair(summary) {
  return errorIssues(summary).length > 0;
}

function versionFromOutput(output) {
  const match = output.match(/OpenClaw\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  return match ? match[1] : null;
}

function hasFatalModelAuth(output) {
  if (/No API key found|token could not be refreshed|refresh token was revoked/i.test(output)) return true;
  if (/Runtime auth/i.test(output) && !/status=usable/i.test(output)) return true;
  return false;
}

function hasExpiredStoredOAuthProfile(output) {
  return /OAuth\/token status[\s\S]*\bexpired\b/i.test(output);
}

function modelAuthExpiryMinutes(output) {
  const matches = [...output.matchAll(/expires in\s+(-?\d+)\s*([mhd])/gi)];
  const minutes = matches.map((match) => {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) return null;
    if (unit === 'h') return value * 60;
    if (unit === 'd') return value * 24 * 60;
    return value;
  }).filter((value) => value !== null && value > 0);
  return minutes.length ? Math.min(...minutes) : null;
}

function discordWebhookUrl(config) {
  if (config.discordWebhookUrl) return config.discordWebhookUrl;
  if (!config.discordWebhookUrlFile) return '';
  const filePath = expandHome(config.discordWebhookUrlFile);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function alertKey(summary) {
  return summary.issues
    .map((issue) => `${issue.severity}:${issue.id}`)
    .sort()
    .join('|') || 'ok';
}

function alertTitle(summary) {
  if (!summary.ok) return 'OpenClaw watchdog error';
  if (summary.issues.some((issue) => issue.id === 'model_auth_warning')) return 'OpenClaw OAuth warning';
  return 'OpenClaw watchdog warning';
}

function alertContent(summary, issues) {
  const lines = [
    `**${alertTitle(summary)}**`,
    `Version: ${summary.version || 'unknown'}`,
    `Status: ${summary.ok ? 'ok with warnings' : 'unhealthy'}`,
    '',
    ...issues.slice(0, 8).map((issue) => `- ${issue.severity.toUpperCase()} ${issue.id}: ${issue.message}`),
  ];
  if (issues.length > 8) lines.push(`- ...and ${issues.length - 8} more`);
  lines.push('', `Log: ${logPath()}`);
  return redact(lines.join('\n')).slice(0, 1900);
}

async function maybeSendAlert(summary, phase) {
  const config = loadConfig();
  const url = discordWebhookUrl(config);
  const issues = alertableIssues(summary, config);
  if (!url || issues.length === 0) return;

  const state = readJsonFile(ALERT_STATE_PATH, {});
  const key = alertKey({ ...summary, issues });
  const cooldownMs = Math.max(1, Number(config.alertCooldownHours || 23)) * 60 * 60 * 1000;
  const previous = state[key] || 0;
  if (Date.now() - previous < cooldownMs) {
    writeLog({ phase: 'alert', command: 'discord webhook', exitCode: 0, durationMs: 0, decision: { sent: false, reason: 'cooldown', key } });
    return;
  }

  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'OpenClaw Watchdog',
        content: alertContent(summary, issues),
      }),
    });
    state[key] = Date.now();
    writeJsonFile(ALERT_STATE_PATH, state);
    writeLog({
      phase: 'alert',
      command: 'discord webhook',
      exitCode: response.ok ? 0 : 1,
      durationMs: Date.now() - started,
      decision: { sent: response.ok, status: response.status, phase, key },
    });
  } catch (error) {
    writeLog({
      phase: 'alert',
      command: 'discord webhook',
      exitCode: 1,
      durationMs: Date.now() - started,
      stderr: snippet(error.message),
      decision: { sent: false, phase, key },
    });
  }
}

async function runChecks(phase = 'check') {
  ensureDirs();
  const config = loadConfig();
  const oc = config.openclawBin;
  const issues = [];
  const results = {};

  if (config.configError) addIssue(issues, 'watchdog_config_invalid', 'error', config.configError);

  results.version = await recordCommand(phase, [oc, '--version'], 'baseline version check');
  const actualVersion = versionFromOutput(`${results.version.stdout}\n${results.version.stderr}`);
  if (results.version.exitCode !== 0) addIssue(issues, 'openclaw_missing', 'error', 'openclaw --version failed');
  if (actualVersion && actualVersion !== config.expectedVersion) {
    addIssue(issues, 'version_mismatch', 'warning', `OpenClaw version is ${actualVersion}; expected ${config.expectedVersion}`, { actualVersion, expectedVersion: config.expectedVersion });
  }

  const checks = [
    ['configValidate', [oc, 'config', 'validate'], 'config validation'],
    ['gatewayStatus', [oc, 'gateway', 'status'], 'gateway status'],
    ['status', [oc, 'status'], 'general status'],
    ['modelsStatus', [oc, 'models', 'status'], 'model auth status'],
    ['cronStatus', [oc, 'cron', 'status', '--json'], 'cron storage status'],
    ['doctorLint', [oc, 'doctor', '--lint', '--json'], 'read-only doctor lint'],
    ['postUpgrade', [oc, 'doctor', '--post-upgrade', '--json'], 'post-upgrade probes'],
    ['cronList', [oc, 'cron', 'list', '--json'], 'cron payload integrity'],
  ];

  for (const [key, argv, decision] of checks) {
    const logOptions = key === 'cronList'
      ? {
          logStdout: (result) => {
            const parsed = parseJson(result);
            if (!Array.isArray(parsed?.jobs)) return result.stdout;
            return JSON.stringify({
              total: parsed.total ?? parsed.jobs.length,
              hasMore: parsed.hasMore ?? false,
              jobs: parsed.jobs.map((job) => ({
                id: job.id,
                name: job.name,
                enabled: job.enabled,
                payloadKind: job.payload?.kind || null,
                status: job.status || job.state?.lastStatus || null,
              })),
            }, null, 2);
          },
        }
      : {};
    results[key] = await recordCommand(phase, argv, decision, logOptions);
  }

  if (results.configValidate.exitCode !== 0) addIssue(issues, 'config_invalid', 'error', 'OpenClaw config validation failed');

  const gatewayOutput = `${results.gatewayStatus.stdout}\n${results.gatewayStatus.stderr}`;
  if (results.gatewayStatus.exitCode !== 0 || !/Connectivity probe:\s*ok/i.test(gatewayOutput) || !/Runtime:\s*running/i.test(gatewayOutput)) {
    addIssue(issues, 'gateway_unreachable', 'error', 'Gateway is not running or connectivity probe failed');
  }
  if (!/LaunchAgent\s+\(loaded\)|LaunchAgent installed\s+.+loaded/i.test(gatewayOutput)) {
    addIssue(issues, 'gateway_service_missing', 'error', 'Gateway LaunchAgent is missing or not loaded');
  }
  if (!new RegExp(`port=${config.gatewayPort}\\b|port\\s*=\\s*${config.gatewayPort}\\b|:${config.gatewayPort}\\b`).test(gatewayOutput)) {
    addIssue(issues, 'gateway_wrong_port', 'error', `Gateway status did not show expected port ${config.gatewayPort}`);
  }

  if (results.status.exitCode !== 0) addIssue(issues, 'status_failed', 'error', 'openclaw status failed');
  const modelOutput = `${results.modelsStatus.stdout}\n${results.modelsStatus.stderr}`;
  if (results.modelsStatus.exitCode !== 0 || hasFatalModelAuth(modelOutput)) {
    addIssue(issues, 'model_auth_unusable', 'error', 'Model authentication appears unusable or expired');
  } else {
    const expiryMinutes = modelAuthExpiryMinutes(modelOutput);
    const noticeMinutes = Math.max(1, Number(config.modelAuthExpiryNoticeHours || 24)) * 60;
    if (expiryMinutes !== null && expiryMinutes <= noticeMinutes) {
      addIssue(issues, 'model_auth_expiring', 'warning', `Model OAuth access token expires in about ${expiryMinutes} minutes`, { remainingMinutes: expiryMinutes });
    }
  }
  if (hasExpiredStoredOAuthProfile(modelOutput)) {
    addIssue(issues, 'model_auth_warning', 'warning', 'A stored model OAuth profile is expired, but runtime auth is currently usable');
  }

  const cronStatus = parseJson(results.cronStatus);
  if (results.cronStatus.exitCode !== 0 || !cronStatus) {
    addIssue(issues, 'cron_status_failed', 'error', 'cron status JSON could not be read');
  } else {
    if (cronStatus.storage !== 'sqlite') addIssue(issues, 'cron_storage_not_sqlite', 'error', `Cron storage is ${cronStatus.storage || 'unknown'}, expected sqlite`);
    if (!cronStatus.sqlitePath || !cronStatus.sqlitePath.endsWith('/.openclaw/state/openclaw.sqlite')) {
      addIssue(issues, 'cron_sqlite_path_unexpected', 'error', `Cron sqlitePath is ${cronStatus.sqlitePath || 'missing'}`);
    }
    if (!Number.isFinite(cronStatus.jobs) || cronStatus.jobs <= 0) addIssue(issues, 'cron_jobs_empty', 'error', 'Cron job count is zero or unavailable');
  }

  const doctorLint = parseJson(results.doctorLint);
  if (doctorLint?.findings?.length) {
    for (const finding of doctorLint.findings) {
      const severity = finding.severity === 'error' ? 'error' : 'warning';
      addIssue(issues, `doctor_${finding.checkId || 'finding'}`, severity, finding.message || 'doctor finding', { checkId: finding.checkId });
    }
  } else if (results.doctorLint.exitCode !== 0) {
    addIssue(issues, 'doctor_lint_failed', 'error', 'doctor lint failed without parseable findings');
  }

  const postUpgrade = parseJson(results.postUpgrade);
  if (postUpgrade?.findings?.some((finding) => finding.level === 'error' || finding.severity === 'error')) {
    addIssue(issues, 'post_upgrade_errors', 'error', 'post-upgrade doctor reported error findings');
  } else if (results.postUpgrade.exitCode !== 0) {
    addIssue(issues, 'post_upgrade_failed', 'error', 'post-upgrade doctor failed');
  }

  const cronList = parseJson(results.cronList);
  if (results.cronList.exitCode !== 0 || !Array.isArray(cronList?.jobs)) {
    addIssue(issues, 'cron_list_failed', 'error', 'cron list JSON could not be read');
  } else {
    for (const [id, label] of IMPORTANT_COMMAND_JOBS) {
      const job = cronList.jobs.find((candidate) => candidate.id === id);
      if (!job) {
        addIssue(issues, 'important_cron_missing', 'error', `Important cron job is missing: ${label}`, { jobId: id });
      } else if (job.payload?.kind !== 'command') {
        addIssue(issues, 'important_cron_not_command', 'error', `Important cron job reverted from command payload: ${label}`, { jobId: id, payloadKind: job.payload?.kind || 'missing' });
      }
    }
  }

  if (issues.some((issue) => issue.severity === 'error')) {
    await recordCommand(phase, [oc, 'gateway', 'status', '--deep'], 'deep gateway check after issue');
    await recordCommand(phase, [oc, 'status', '--deep'], 'deep status check after issue', { timeoutMs: 180_000 });
  }

  const summary = {
    ok: !issues.some((issue) => issue.severity === 'error'),
    suspicious: issues.length > 0,
    version: actualVersion,
    issues,
  };
  writeLog({ phase, command: 'summary', exitCode: summary.ok ? 0 : 1, durationMs: 0, decision: summary });
  return summary;
}

function copyIfExists(source, destDir) {
  const resolved = source.replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(resolved)) return null;
  const target = path.join(destDir, resolved.replace(os.homedir(), 'home').replace(/^\/+/, '').replace(/\//g, '__'));
  fs.cpSync(resolved, target, { recursive: true, errorOnExist: false, force: true, preserveTimestamps: true });
  return { source: resolved, target };
}

function createBackup(reason) {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [
    '~/.openclaw/openclaw.json',
    '~/.openclaw/state/openclaw.sqlite',
    '~/.openclaw/state/openclaw.sqlite-wal',
    '~/.openclaw/state/openclaw.sqlite-shm',
    '~/.openclaw/agents/main/sessions/sessions.json',
  ].map((item) => copyIfExists(item, dir)).filter(Boolean);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ timestamp: nowIso(), reason, copied }, null, 2));
  writeLog({ phase: 'repair', command: 'backup', exitCode: 0, durationMs: 0, decision: { backupDir: dir, reason, files: copied.map((item) => item.source) } });
  return dir;
}

async function repair() {
  const config = loadConfig();
  const oc = config.openclawBin;
  const before = await runChecks('check');
  const backupDir = createBackup(before.issues.map((issue) => issue.id).join(',') || 'manual repair');
  writeLog({ phase: 'repair', command: 'repair-start', exitCode: 0, durationMs: 0, decision: { backupDir, issues: before.issues } });

  const flow = [
    [oc, 'doctor', '--fix', '--non-interactive'],
    [oc, 'doctor', '--state-sqlite', 'compact', '--json'],
    [oc, 'secrets', 'reload'],
    [oc, 'gateway', 'restart'],
    [oc, 'config', 'validate'],
    [oc, 'gateway', 'status'],
    [oc, 'status'],
    [oc, 'models', 'status'],
    [oc, 'cron', 'status', '--json'],
    [oc, 'doctor', '--post-upgrade', '--json'],
  ];

  for (const argv of flow) {
    await recordCommand('repair', argv, 'safe repair sequence');
  }

  if (before.issues.some((issue) => issue.id === 'gateway_service_missing' || issue.id === 'gateway_wrong_port')) {
    await recordCommand('repair', [oc, 'gateway', 'install', '--force'], 'gateway service repair');
    await recordCommand('repair', [oc, 'gateway', 'restart'], 'restart after service reinstall');
  }

  const after = await runChecks('verify');
  if (!after.ok && before.issues.some((issue) => issue.id === 'version_mismatch') && !config.allowDowngrade) {
    writeLog({ phase: 'repair', command: 'downgrade', exitCode: 0, durationMs: 0, decision: 'skipped: allowDowngrade is false' });
  }
  await maybeSendAlert(after, 'repair');
  return after;
}

async function once() {
  const first = await runChecks('check');
  if (!shouldRepair(first)) {
    await maybeSendAlert(first, 'check');
    return first;
  }
  writeLog({ phase: 'check', command: 'decision', exitCode: 0, durationMs: 0, decision: 'running repair because check found errors' });
  const after = await repair();
  await maybeSendAlert(after, 'verify');
  return after;
}

function launchctl(args) {
  return runCommand(['launchctl', ...args], { timeoutMs: 30_000 });
}

function plistXml() {
  const nodePath = process.execPath;
  const scriptPath = path.join(__dirname, 'openclaw-watchdog.js');
  const pathValue = [
    path.dirname(nodePath),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(os.homedir(), '.local/bin'),
  ].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>once</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>10</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'launchd.err.log')}</string>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>PATH</key>
    <string>${pathValue}</string>
    <key>TZ</key>
    <string>Asia/Taipei</string>
  </dict>
</dict>
</plist>
`;
}

async function install() {
  ensureDirs();
  if (process.platform !== 'darwin') throw new Error('install is macOS LaunchAgent only');
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  if (fs.existsSync(PLIST_PATH)) await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  fs.writeFileSync(PLIST_PATH, plistXml(), { mode: 0o644 });
  fs.chmodSync(path.join(__dirname, 'openclaw-watchdog.js'), 0o755);
  await launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
  writeLog({ phase: 'install', command: 'launchctl bootstrap', exitCode: 0, durationMs: 0, decision: { plist: PLIST_PATH, schedule: 'RunAtLoad and daily 08:10 Asia/Taipei' } });
}

async function uninstall() {
  if (process.platform === 'darwin') await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  writeLog({ phase: 'uninstall', command: 'uninstall watchdog LaunchAgent', exitCode: 0, durationMs: 0, decision: { plist: PLIST_PATH } });
}

async function status() {
  ensureDirs();
  const ctl = process.platform === 'darwin' ? await runCommand(['launchctl', 'print', `gui/${process.getuid()}/${LABEL}`], { timeoutMs: 30_000 }) : null;
  const logs = fs.readdirSync(LOG_DIR).filter((name) => name.endsWith('.jsonl')).sort();
  const recent = [];
  for (const file of logs.slice(-3)) {
    const lines = fs.readFileSync(path.join(LOG_DIR, file), 'utf8').trim().split('\n').filter(Boolean);
    recent.push(...lines.slice(-5).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    }));
  }
  console.log(JSON.stringify({
    label: LABEL,
    plist: PLIST_PATH,
    plistExists: fs.existsSync(PLIST_PATH),
    launchctlExitCode: ctl?.exitCode,
    launchctl: ctl ? snippet(`${ctl.stdout}\n${ctl.stderr}`) : 'not macOS',
    logDir: LOG_DIR,
    backupRoot: BACKUP_ROOT,
    recent: recent.slice(-10),
  }, null, 2));
}

function acquireLock() {
  ensureDirs();
  try {
    fs.mkdirSync(LOCK_DIR);
    process.on('exit', () => fs.rmSync(LOCK_DIR, { recursive: true, force: true }));
    return true;
  } catch {
    const stat = fs.statSync(LOCK_DIR);
    if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      fs.mkdirSync(LOCK_DIR);
      process.on('exit', () => fs.rmSync(LOCK_DIR, { recursive: true, force: true }));
      return true;
    }
    writeLog({ phase: 'check', command: 'lock', exitCode: 0, durationMs: 0, decision: 'another watchdog run is active' });
    return false;
  }
}

async function main() {
  const command = process.argv[2] || 'help';
  if (!['install', 'uninstall', 'status', 'help'].includes(command) && !acquireLock()) return;

  if (command === 'check') {
    const summary = await runChecks('check');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } else if (command === 'repair') {
    const summary = await repair();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } else if (command === 'once') {
    const summary = await once();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } else if (command === 'install') {
    await install();
    console.log(`Installed ${LABEL} at ${PLIST_PATH}`);
  } else if (command === 'uninstall') {
    await uninstall();
    console.log(`Uninstalled ${LABEL}`);
  } else if (command === 'status') {
    await status();
  } else {
    console.log('Usage: openclaw-watchdog check|repair|once|install|uninstall|status');
    process.exit(command === 'help' ? 0 : 2);
  }
}

main().catch((error) => {
  writeLog({ phase: 'error', command: process.argv.slice(2).join(' ') || 'help', exitCode: 1, durationMs: 0, stderr: snippet(error.stack || error.message), decision: 'unhandled error' });
  console.error(redact(error.stack || error.message));
  process.exit(1);
});
