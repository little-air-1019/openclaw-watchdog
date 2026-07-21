#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TZ = 'Asia/Taipei';
const REPO = '/Users/twipc00907426/Developer/cathaybk2026/ida-meetings';
const MEMBERS_PATH = path.join(REPO, 'token-usage/members.json');
const REPORT_DIR = '/Users/twipc00907426/.openclaw/workspace/reports';
const DISCORD_CHANNEL_ID = '1506900624845967430';

function taipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function weekday(dateString) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(new Date(`${dateString}T12:00:00+08:00`));
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bestEffortFetch() {
  try {
    const token = fs.readFileSync('/Users/twipc00907426/.ida-ops-bot/github-token', 'utf8').trim();
    if (!token) return;
    const header = Buffer.from(`x-access-token:${token}`).toString('base64');
    execFileSync('git', [
      '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}`,
      '-C', REPO,
      'fetch', 'origin', 'main',
    ], { stdio: 'ignore', timeout: 120000 });
  } catch {
    // Best effort only. Local latest.json files are the fallback source.
  }
}

async function sendDiscordMessage(content) {
  const token = fs.readFileSync('/Users/twipc00907426/.openclaw/discord-bot-token.secret', 'utf8').trim();
  const response = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`Discord message failed: ${response.status} ${await response.text()}`);
}

async function uploadDiscordFile(filePath, content) {
  const token = fs.readFileSync('/Users/twipc00907426/.openclaw/discord-bot-token.secret', 'utf8').trim();
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content }));
  form.append('files[0]', new Blob([fs.readFileSync(filePath)], { type: 'text/markdown' }), path.basename(filePath));
  const response = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord upload failed: ${response.status} ${await response.text()}`);
}

function dateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  while (current <= end) {
    dates.push(new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function loadUsage(today) {
  const month = today.slice(0, 7);
  const members = readJson(MEMBERS_PATH).members || [];
  return members.map(member => {
    const file = path.join(REPO, month, 'token-usage', member.member_id, 'latest.json');
    try {
      const data = readJson(file);
      const todayRecord = data.today?.date === today ? data.today : { total_tokens: 0 };
      const stale = data.today?.date && data.today.date !== today;
      return {
        member,
        file,
        data,
        todayRecord,
        missing: false,
        stale,
      };
    } catch {
      return {
        member,
        file,
        data: null,
        todayRecord: { total_tokens: 0 },
        missing: true,
        stale: false,
      };
    }
  });
}

function buildReport(today, rows) {
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  const days = dateRange(monthStart, today);
  const teamToday = rows.reduce((sum, row) => sum + Number(row.todayRecord.total_tokens || 0), 0);
  const teamMonth = rows.reduce((sum, row) => sum + Number(row.data?.this_month?.total_tokens || 0), 0);
  const missing = rows.filter(row => row.missing);
  const stale = rows.filter(row => row.stale);

  const ranked = [...rows].sort((a, b) => {
    const byToday = Number(b.todayRecord.total_tokens || 0) - Number(a.todayRecord.total_tokens || 0);
    if (byToday !== 0) return byToday;
    return Number(b.data?.this_month?.total_tokens || 0) - Number(a.data?.this_month?.total_tokens || 0);
  });

  const daily = days.map(day => {
    const total = rows.reduce((sum, row) => {
      return sum + Number(row.data?.daily_in_month?.[day]?.total_tokens || 0);
    }, 0);
    return `- ${day.replaceAll('-', '/')}：${fmt(total)} tokens`;
  });

  const lines = [
    `# Claude Code Token 使用分析（${today.replaceAll('-', '/')}）`,
    '',
    '資料來源：repo `cathaybk2026/ida-meetings` 的 `<YYYY-MM>/token-usage/`',
    '統計口徑：已上傳到 repo 的 Claude Code CLI token 使用量；不含 Claude.ai / Desktop App。',
    '',
    '## 團隊總覽',
    '',
    `- 今日團隊合計：${fmt(teamToday)} tokens`,
    `- 本月團隊累計：${fmt(teamMonth)} tokens`,
    `- 資料缺失：${missing.length} 人`,
    `- 資料逾時：${stale.length} 人`,
    '',
    '## 人員排名',
    '',
  ];

  ranked.forEach((row, index) => {
    const todayTokens = Number(row.todayRecord.total_tokens || 0);
    const monthTokens = Number(row.data?.this_month?.total_tokens || 0);
    const status = row.missing ? '資料缺失' : row.stale ? '資料逾時' : '正常';
    lines.push(`${index + 1}. ${row.member.display_name}（${row.member.member_id}）`);
    lines.push(`   - 今日：${todayTokens ? `${fmt(todayTokens)} tokens` : '未使用'}`);
    lines.push(`   - 本月：${fmt(monthTokens)} tokens`);
    if (teamToday > 0) lines.push(`   - 團隊今日占比：約 ${Math.round(todayTokens * 1000 / teamToday) / 10}%`);
    lines.push(`   - 狀態：${status}`);
    lines.push('');
  });

  lines.push('## 每日團隊使用量');
  lines.push('');
  lines.push(...daily);
  lines.push('');
  lines.push('## 觀察');
  lines.push('');
  const top = ranked.find(row => Number(row.todayRecord.total_tokens || 0) > 0);
  if (top) {
    lines.push(`- 今日最高使用者為 ${top.member.display_name}，使用 ${fmt(top.todayRecord.total_tokens)} tokens。`);
  } else {
    lines.push('- 今日尚未看到已上傳的 Claude Code CLI 使用量。');
  }
  lines.push(`- 本月團隊累計為 ${fmt(teamMonth)} tokens。`);
  if (missing.length > 0) lines.push(`- 資料缺失：${missing.map(row => row.member.display_name).join('、')}。`);
  if (stale.length > 0) lines.push(`- 資料逾時：${stale.map(row => `${row.member.display_name}（最新 ${row.data?.today?.date || '未知'}）`).join('、')}。`);
  if (missing.length === 0 && stale.length === 0) lines.push('- 今日資料皆可讀取且日期正常。');

  return lines.join('\n');
}

async function main() {
  const today = process.env.OPENCLAW_CRON_DATE || taipeiDate();
  if (['Sat', 'Sun'].includes(weekday(today))) {
    console.log('NO_REPLY');
    return;
  }

  let rows;
  try {
    bestEffortFetch();
    rows = loadUsage(today);
  } catch {
    await sendDiscordMessage('Claude Code 用量回報資料讀取失敗');
    console.log('NO_REPLY');
    return;
  }

  const report = buildReport(today, rows);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filePath = path.join(REPORT_DIR, `claude-code-token-usage-${today}.md`);
  fs.writeFileSync(filePath, report);

  if (process.env.OPENCLAW_DRY_RUN === '1') {
    console.log(filePath);
    console.log(report.slice(0, 2000));
    return;
  }

  await uploadDiscordFile(filePath, 'Claude Code token 用量報告如附件。');
  console.log('NO_REPLY');
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
