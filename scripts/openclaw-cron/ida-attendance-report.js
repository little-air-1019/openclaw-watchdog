#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const TZ = 'Asia/Taipei';
const ACCOUNT = 'kf135117@gmail.com';
const CALENDAR_ID = '7f9672e3af87254acf827cd53151655b51e2df42b4575ca94450fd45b9ab563c@group.calendar.google.com';
const MEMBERS_PATH = '/Users/twipc00907426/Developer/cathaybk2026/ida-meetings/token-usage/members.json';

function taipeiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
  };
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function runGog(args) {
  return execFileSync('gog', args, {
    cwd: '/Users/twipc00907426',
    env: { ...process.env, HOME: '/Users/twipc00907426' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

function isAuthError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
  return /No auth for calendar|missing --account|OAuth|auth|credential|token/i.test(text);
}

function normalizeSummary(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function aliasesFor(name) {
  const aliases = new Set([name]);
  if ([...name].length >= 3) aliases.add([...name].slice(1).join(''));
  return aliases;
}

function parseEvent(summary, members) {
  const normalized = normalizeSummary(summary);
  if (!normalized || /IDA\s*Daily\s*Scrum/i.test(normalized)) return null;

  for (const member of members) {
    for (const alias of aliasesFor(member.display_name)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = normalized.match(new RegExp(`^${escaped}\\s*[_\\-:： ]?\\s*(.*)$`));
      if (!match) continue;

      let detail = match[1].trim();
      detail = detail.replace(/^[(（]\s*/, '').replace(/\s*[)）]$/, '').trim();
      if (!detail) continue;

      if (/^(休|全天|請假|全天請假)$/.test(detail)) {
        return { member, kind: 'leave', detail: '全天請假' };
      }
      if (/^上午/.test(detail)) {
        return { member, kind: 'leave', detail: '上午請假' };
      }
      if (/^下午/.test(detail)) {
        return { member, kind: 'leave', detail: '下午請假' };
      }
      const time = detail.match(/(\d{1,2}:\d{2})\s*[-~－–]\s*(\d{1,2}:\d{2})/);
      if (time) {
        return { member, kind: 'leave', detail: `${time[1]}-${time[2]} 不在` };
      }
      return { member, kind: 'other', detail };
    }
  }
  return null;
}

function main() {
  const today = process.env.OPENCLAW_CRON_DATE || taipeiParts().date;
  const weekdayMap = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };
  const weekday = weekdayMap[taipeiParts(new Date(`${today}T12:00:00+08:00`)).weekday] || '';
  if (weekday === '六' || weekday === '日') {
    console.log('NO_REPLY');
    return;
  }

  let members;
  try {
    members = JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf8')).members || [];
  } catch {
    console.log('IDA 團隊出缺勤回報資料讀取失敗');
    return;
  }

  let events;
  try {
    runGog(['auth', 'list', '--no-input']);
    runGog(['status', '-a', ACCOUNT, '--no-input']);
    const raw = runGog([
      'calendar', 'events', CALENDAR_ID,
      '--from', today,
      '--to', addDays(today, 1),
      '--all-pages',
      '--json',
      '--results-only',
      '-a', ACCOUNT,
      '--no-input',
    ]);
    events = JSON.parse(raw).filter(event => {
      const local = event.startLocal || event.start?.dateTime || event.start?.date || '';
      return String(local).startsWith(today);
    });
  } catch (error) {
    if (isAuthError(error)) {
      console.log('⚠️ IDA 出缺勤回報失敗：Google Calendar OAuth 未登入或失效，需要重新執行 `gog auth add kf135117@gmail.com --services calendar`');
    } else {
      console.log('IDA 團隊出缺勤回報資料讀取失敗');
    }
    return;
  }

  const leave = new Map();
  const other = new Map();
  for (const event of events) {
    const parsed = parseEvent(event.summary, members);
    if (!parsed) continue;
    const target = parsed.kind === 'leave' ? leave : other;
    const key = parsed.member.display_name;
    const list = target.get(key) || [];
    list.push(parsed.detail);
    target.set(key, list);
  }

  const present = members
    .map(m => m.display_name)
    .filter(name => !leave.has(name) && !other.has(name));

  const lines = [
    `🧭 IDA 團隊出缺勤 — ${today}（週${weekday}）`,
    '',
    `✅ 出勤：${present.length ? present.join('、') : '目前無'}`,
    '🏖️ 請假 / 不在：',
  ];

  if (leave.size === 0) {
    lines.push('目前無登記');
  } else {
    for (const [name, items] of leave) lines.push(`- ${name}：${items.join('、')}`);
  }

  lines.push('📍 其他行程：');
  if (other.size === 0) {
    lines.push('目前無登記');
  } else {
    for (const [name, items] of other) lines.push(`- ${name}：${items.join('、')}`);
  }

  console.log(lines.join('\n'));
}

main();
