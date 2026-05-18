import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SB = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const APP = {
  title: 'Dio Focus Group Scheduler',
  organisationName: 'Diocesan School for Girls',
  defaultLocation: 'To be confirmed',
  ...(window.APP_CONFIG || {}),
};

const $ = (selector) => document.querySelector(selector);

const loadingEl = $('#loading');
const notAdminEl = $('#not-admin');
const contentEl = $('#admin-content');
const timeslotOverviewEl = $('#timeslot-overview');
const groupDetailEl = $('#group-detail');
const respondentTableEl = $('#respondent-table');
const summaryEl = $('#summary');
const toastEl = $('#toast');

let session = null;
let summaryRows = [];
let responses = [];
let extraAttendees = new Map(); // group_id → [{email, name, added_at}]
let timeOptions = [];           // [{id, label, starts_at, ends_at}] sorted by starts_at
let selectedGroupId = null;
let respondentSort = { col: 'group', dir: 'asc' };
let searchTerm = '';

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toast(message, kind = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${kind}`;
  setTimeout(() => { toastEl.className = 'toast'; }, 3300);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function utcStamp(dateValue) {
  const d = new Date(dateValue);
  return d.getUTCFullYear()
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + 'T'
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())
    + 'Z';
}

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine(line) {
  const chunks = [];
  let rest = line;
  while (rest.length > 74) {
    chunks.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  chunks.push(rest);
  return chunks.join('\r\n');
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage, 'success');
  } catch (error) {
    console.error(error);
    toast('Clipboard access was blocked.', 'error');
  }
}

function formatDateRange(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const datePart = start.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
  const startTime = start.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
  if (start.toDateString() === end.toDateString()) return `${datePart}, ${startTime}–${endTime}`;
  const endPart = end.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${startTime} – ${endPart}`;
}

// ── Checklist persistence (localStorage) ─────────────────────────────────────

function getChecklist() {
  try { return JSON.parse(localStorage.getItem('focus-group-checklists') || '{}'); } catch { return {}; }
}

function setChecklistItem(key, field, value) {
  const cl = getChecklist();
  if (!cl[key]) cl[key] = {};
  cl[key][field] = value;
  localStorage.setItem('focus-group-checklists', JSON.stringify(cl));
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ─── Data models ──────────────────────────────────────────────────────────────

function groupModels() {
  const byGroup = new Map();
  for (const row of summaryRows) {
    if (!byGroup.has(row.group_id)) {
      byGroup.set(row.group_id, {
        id: row.group_id,
        name: row.group_name,
        description: row.group_description,
        total: row.total_in_group,
        final_sessions_count: Number(row.final_sessions_count || 0),
        times: [],
      });
    }
    byGroup.get(row.group_id).times.push({
      id: row.time_option_id,
      label: row.time_label,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      available_count: row.available_count,
      unavailable_count: row.unavailable_count,
      is_final: row.is_final || false,
      final_location: row.final_session_location || null,
      final_note: row.final_session_note || null,
    });
  }
  return [...byGroup.values()];
}

function finalTimesForGroup(group) {
  return (group?.times || []).filter((t) => t.is_final);
}

function responsesForGroup(groupId) {
  const primary = responses
    .filter((row) => row.group_id === groupId)
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));

  const extras = (extraAttendees.get(groupId) || []).map((e) => {
    const orig = responses.find((r) => r.user_email.toLowerCase() === e.email.toLowerCase());
    return {
      user_email: e.email,
      user_name: e.name || e.email,
      group_id: orig?.group_id || '',
      group_name: orig ? `${orig.group_name} (extra)` : 'Extra attendee',
      available_time_option_ids: orig?.available_time_option_ids || [],
      available_labels: orig?.available_labels || [],
      unavailable_labels: orig?.unavailable_labels || [],
    };
  });

  return [...primary, ...extras];
}

// People available for a specific confirmed session (used for per-session buttons)
function responsesForSession(groupId, timeOptionId) {
  const primary = responses
    .filter((r) => r.group_id === groupId && r.available_time_option_ids?.includes(timeOptionId))
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));

  // Extra attendees are included in all sessions for the group
  const extras = (extraAttendees.get(groupId) || []).map((e) => {
    const orig = responses.find((r) => r.user_email.toLowerCase() === e.email.toLowerCase());
    return {
      user_email: e.email,
      user_name: e.name || e.email,
      group_id: orig?.group_id || '',
      group_name: orig ? `${orig.group_name} (extra)` : 'Extra attendee',
      available_time_option_ids: orig?.available_time_option_ids || [],
      available_labels: orig?.available_labels || [],
      unavailable_labels: orig?.unavailable_labels || [],
    };
  });

  return [...primary, ...extras];
}

function firstName(fullName) {
  if (!fullName) return '?';
  return fullName.trim().split(/\s+/)[0];
}

function sortName(row) {
  const name = (row.user_name || '').trim().toLowerCase();
  const email = (row.user_email || '').toLowerCase();
  return name ? `${name}|${email}` : email;
}

function finalTimeForGroup(group) {
  return (group?.times || []).find((t) => t.is_final) || null;
}

function groupById(groupId) {
  return groupModels().find((g) => g.id === groupId) || null;
}

// Returns the Set of time_option_ids confirmed as final by groups OTHER than groupId
function takenByOtherGroupsTimeIds(groupId) {
  return new Set(
    summaryRows
      .filter((r) => r.is_final && r.group_id !== groupId)
      .map((r) => r.time_option_id),
  );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render() {
  renderSummary();
  renderSidebar();
  renderTimeslotOverview();
  renderGroupSelector();
  renderGroupDetail(selectedGroupId);
  renderRespondents();
  renderSuggestions();
  renderSubmitForm();
}

function renderSidebar() {
  const sidebarGroupsEl = $('#sidebar-groups');
  if (!sidebarGroupsEl) return;
  const groups = groupModels();
  sidebarGroupsEl.innerHTML = groups.map((g) => {
    const finalised = g.final_sessions_count > 0;
    const active = g.id === selectedGroupId;
    const cls = ['sidebar-link', finalised ? 'sidebar-link--finalised' : '', active ? 'sidebar-link--active' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-group-id="${escapeHtml(g.id)}">${finalised ? '✓' : '○'} ${escapeHtml(g.name)}</button>`;
  }).join('');
  sidebarGroupsEl.querySelectorAll('[data-group-id]').forEach((btn) => {
    btn.addEventListener('click', () => selectGroup(btn.dataset.groupId));
  });
}

function selectGroup(groupId) {
  selectedGroupId = groupId;
  const sel = $('#group-select');
  if (sel) sel.value = groupId;
  renderGroupDetail(groupId);
  renderSidebar();
  document.getElementById('section-groups')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSummary() {
  const groups = groupModels();

  const cards = groups.map((group) => {
    const total = Number(group.total || 0);
    const isFinalised = group.final_sessions_count > 0;
    const finalTime = finalTimeForGroup(group);

    const finalTimes = finalTimesForGroup(group);
    const takenIds = takenByOtherGroupsTimeIds(group.id);
    const bestTime = isFinalised
      ? (finalTimes[0] || null)
      : group.times
          .filter((t) => !takenIds.has(t.id))
          .reduce((best, t) => {
            return Number(t.available_count || 0) > Number(best?.available_count || 0) ? t : best;
          }, null);

    const bestCount = Number(bestTime?.available_count || 0);
    const pct = total > 0 ? Math.round((bestCount / total) * 100) : 0;
    const slotLabel = bestTime?.label || '—';

    const barFill = `<div class="bar-cell" style="margin:5px 0 2px">
      <div class="bar-track" style="width:100%;flex:1"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="readiness-count">${bestCount}/${total}</span>
    </div>`;

    const status = isFinalised
      ? `<div class="readiness-status"><span class="badge good">Finalised</span></div>`
      : `<div class="readiness-status" style="color:var(--muted);font-size:11px">Pending</div>`;

    return `
      <div class="readiness-card${isFinalised ? ' readiness-card--finalised' : ''}" data-group-id="${escapeHtml(group.id)}" role="button" tabindex="0">
        <div class="readiness-name">${escapeHtml(group.name)}</div>
        ${barFill}
        <div class="readiness-slot">${escapeHtml(slotLabel)}</div>
        ${status}
      </div>`;
  }).join('');

  // Scheduling summary — coverage if best slot picked per group
  let totalBestAvail = 0;
  let totalRespondents = 0;
  const byDay = new Map(); // 'Mon 19 May' → [{groupName, available, total, slotLabel}]

  for (const group of groups) {
    const gTotal = Number(group.total || 0);
    totalRespondents += gTotal;
    const isFinalised = group.final_sessions_count > 0;
    const takenIdsForSched = takenByOtherGroupsTimeIds(group.id);
    const bestTime = isFinalised
      ? finalTimeForGroup(group)
      : group.times
          .filter((t) => !takenIdsForSched.has(t.id))
          .reduce((best, t) => Number(t.available_count || 0) > Number(best?.available_count || 0) ? t : best, null);
    if (!bestTime) continue;
    const avail = Number(bestTime.available_count || 0);
    totalBestAvail += avail;
    const dayLabel = new Date(bestTime.starts_at).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
    if (!byDay.has(dayLabel)) byDay.set(dayLabel, []);
    byDay.get(dayLabel).push({ groupName: group.name, available: avail, total: gTotal, slotLabel: bestTime.label, finalised: isFinalised });
  }

  const leftOutTotal = totalRespondents - totalBestAvail;
  const dayRows = [...byDay.entries()].map(([day, items]) => {
    const groupList = items.map((i) => `<span class="sched-group${i.finalised ? ' sched-group--final' : ''}">${escapeHtml(i.groupName)} <span class="subtle">${i.available}/${i.total}</span></span>`).join('');
    return `<div class="sched-day"><span class="sched-day-label">${escapeHtml(day)}</span><div class="sched-groups">${groupList}</div></div>`;
  }).join('');

  const schedSummary = totalRespondents > 0 ? `
    <div class="sched-summary">
      <div class="sched-summary-stat">
        Best-slot coverage: <strong>${totalBestAvail}/${totalRespondents}</strong> people
        ${leftOutTotal > 0 ? `· <span style="color:var(--red,#c0392b)">${leftOutTotal} left out across all groups</span>` : '· <span style="color:var(--green)">everyone covered</span>'}
      </div>
      <div class="sched-days">${dayRows}</div>
    </div>
  ` : '';

  summaryEl.innerHTML = `
    <div class="panel-header">
      <h2>Group readiness</h2>
      <span class="meta-line">${responses.length} respondent${responses.length === 1 ? '' : 's'} · ${groups.filter((g) => g.final_sessions_count > 0).length}/${groups.length} finalised</span>
    </div>
    <div class="readiness-grid">${cards}</div>
    ${schedSummary}
  `;

  summaryEl.querySelectorAll('.readiness-card').forEach((card) => {
    const activate = () => selectGroup(card.dataset.groupId);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(); });
  });
}

function renderTimeslotOverview() {
  const totals = new Map();
  for (const row of summaryRows) {
    if (!totals.has(row.time_option_id)) {
      totals.set(row.time_option_id, {
        label: row.time_label, starts_at: row.starts_at,
        total: 0,
        bestPending: '', bestPendingCount: 0, // highest-available unfinalised group
      });
    }
    const entry = totals.get(row.time_option_id);
    const n = Number(row.available_count || 0);
    entry.total += n;
    const groupFinalised = Number(row.final_sessions_count || 0) > 0;
    if (!groupFinalised && n > entry.bestPendingCount) {
      entry.bestPendingCount = n;
      entry.bestPending = row.group_name;
    }
  }

  if (totals.size === 0) {
    timeslotOverviewEl.innerHTML = '<p class="empty" style="padding:14px">No responses yet.</p>';
    return;
  }

  const sorted = [...totals.values()].sort((a, b) => b.total - a.total);
  const max = sorted[0].total || 1;

  timeslotOverviewEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time slot</th>
          <th>Total available</th>
          <th>Most interest from <span style="font-weight:400;opacity:0.7">(unfinalised groups only)</span></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((row) => `
          <tr>
            <td>${escapeHtml(row.label)}</td>
            <td>
              <div class="bar-cell">
                <div class="bar-track"><div class="bar-fill" style="width:${Math.round((row.total / max) * 100)}%"></div></div>
                <span>${row.total}</span>
              </div>
            </td>
            <td class="subtle">${row.bestPending ? escapeHtml(row.bestPending) : '<span style="opacity:0.45">all groups finalised</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderGroupSelector() {
  const groups = groupModels();
  const groupSelectEl = $('#group-select');
  if (!groupSelectEl) return;

  if (!selectedGroupId && groups.length > 0) {
    selectedGroupId = groups[0].id;
  }

  groupSelectEl.innerHTML = groups.map((g) => `
    <option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}${g.final_time_option_id ? ' ✓' : ''}</option>
  `).join('');

  if (selectedGroupId) groupSelectEl.value = selectedGroupId;
}

function renderGroupDetail(groupId) {
  if (!groupId) {
    groupDetailEl.innerHTML = '<p class="empty">Select a group above.</p>';
    return;
  }

  const group = groupModels().find((g) => g.id === groupId);
  if (!group) {
    groupDetailEl.innerHTML = '<p class="empty">Group not found.</p>';
    return;
  }

  const primaryRespondents = responses
    .filter((r) => r.group_id === group.id)
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));
  const total = Number(group.total || 0);
  const finalTimes = finalTimesForGroup(group);
  const finalTime = finalTimes[0] || null;

  const takenByOthers = takenByOtherGroupsTimeIds(group.id);

  // Sort: final slots first, then non-taken by available desc, then taken slots last
  const sortedTimes = [...group.times].sort((a, b) => {
    const aFinal = a.is_final, bFinal = b.is_final;
    const aTaken = takenByOthers.has(a.id) && !aFinal;
    const bTaken = takenByOthers.has(b.id) && !bFinal;
    if (aFinal !== bFinal) return aFinal ? -1 : 1;
    if (aTaken !== bTaken) return aTaken ? 1 : -1;
    return Number(b.available_count || 0) - Number(a.available_count || 0);
  });

  // Best = highest-available non-final non-taken slot
  const bestTimeId = group.times
    .filter((t) => !t.is_final && !takenByOthers.has(t.id))
    .reduce((best, t) =>
      Number(t.available_count || 0) > Number(best?.available_count || 0) ? t : best, null)?.id;

  const maxAvail = sortedTimes.filter((t) => !t.is_final && !takenByOthers.has(t.id))
    .reduce((m, t) => Math.max(m, Number(t.available_count || 0)), 0) || 1;

  const groupResponses = responses.filter((r) => r.group_id === group.id);

  const timesHtml = sortedTimes.map((time) => {
    const available = Number(time.available_count || 0);
    const leftOut = total > 0 ? total - available : 0;
    const pct = maxAvail > 0 ? Math.round((available / maxAvail) * 100) : 0;
    const isFinal = time.is_final;
    const isTaken = takenByOthers.has(time.id) && !isFinal;
    const isBest = !isFinal && !isTaken && time.id === bestTimeId && available > 0;
    const coverageText = total > 0
      ? `${available}/${total}${leftOut > 0 ? ` · <span style="color:var(--red,#c0392b)">${leftOut} left out</span>` : ' · <span style="color:var(--green)">all covered</span>'}`
      : `${available} available`;

    const yesNames = groupResponses
      .filter((r) => r.available_time_option_ids?.includes(time.id))
      .map((r) => escapeHtml(firstName(r.user_name || r.user_email)));
    const noNames = groupResponses
      .filter((r) => !r.available_time_option_ids?.includes(time.id))
      .map((r) => escapeHtml(firstName(r.user_name || r.user_email)));

    const namesHtml = `
      <div class="slot-names">
        ${yesNames.length ? `<span class="slot-names-yes">✓ ${yesNames.join(', ')}</span>` : ''}
        ${noNames.length ? `<span class="slot-names-no">✗ ${noNames.join(', ')}</span>` : ''}
      </div>`;

    const rowStyle = isTaken ? ' style="opacity:0.55"' : '';
    return `
      <tr class="${isFinal ? 'slot-final-row' : ''}"${rowStyle}>
        <td>${escapeHtml(time.label)}</td>
        <td class="subtle">${escapeHtml(formatDateRange(time.starts_at, time.ends_at))}</td>
        <td>
          <div class="bar-cell">
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="subtle">${coverageText}</span>
          </div>
          ${namesHtml}
        </td>
        <td class="slot-actions">
          ${isBest ? '<span class="badge good">Best</span>' : ''}
          ${isFinal ? '<span class="badge good">Final</span>' : ''}
          ${isTaken ? '<span class="badge neutral" title="Another group has confirmed this slot">Taken</span>' : ''}
          ${isFinal
            ? `<button class="ghost remove-final" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(time.id)}" style="margin-left:6px">Remove final</button>`
            : `<button class="secondary set-final" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(time.id)}" style="margin-left:6px">Set as final</button>`
          }
        </td>
      </tr>
    `;
  }).join('');

  // Compute uncovered respondents (needed for finalBlock + notBooked panel)
  const coveredEmails = new Set();
  for (const time of group.times) {
    if (!time.is_final) continue;
    for (const r of primaryRespondents) {
      if (r.available_time_option_ids?.includes(time.id)) coveredEmails.add(r.user_email.toLowerCase());
    }
  }
  const notBookedRespondents = primaryRespondents.filter((r) => !coveredEmails.has(r.user_email.toLowerCase()));

  const cl = getChecklist();

  const finalBlock = finalTimes.length > 0 ? `
    <div class="notification-tools" style="margin-top:16px">
      <h3 style="margin:0 0 10px;font-size:14px;font-weight:650">Confirmed session${finalTimes.length > 1 ? 's' : ''}</h3>
      ${finalTimes.map((ft) => {
        const sessionCount = responsesForSession(group.id, ft.id).length;
        const sessionKey   = `session:${group.id}:${ft.id}`;
        const clState      = cl[sessionKey] || {};
        const mkItem = (field, label) => {
          const done = !!clState[field];
          return `<label class="checklist-item${done ? ' checklist-item--done' : ''}">
            <input type="checkbox" class="cl-check" data-key="${escapeHtml(sessionKey)}" data-field="${field}"${done ? ' checked' : ''}>
            <span>${label}</span>
          </label>`;
        };
        return `
        <div class="final-session-entry">
          <div><strong>${escapeHtml(formatDateRange(ft.starts_at, ft.ends_at))}</strong>
            <span class="subtle" style="margin-left:8px">${sessionCount} attendee${sessionCount === 1 ? '' : 's'}</span>
          </div>
          <div class="subtle">${escapeHtml(ft.final_location || APP.defaultLocation)}${ft.final_note ? ` — ${escapeHtml(ft.final_note)}` : ''}</div>
          <div class="actions" style="margin-top:8px">
            <button class="secondary copy-names-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Copy names</button>
            <button class="secondary copy-emails-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Copy emails</button>
            <button class="secondary copy-message-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Copy message</button>
            <button class="secondary copy-forward-note-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Copy Teams forward note</button>
            <button class="secondary download-ics-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Download .ics</button>
            <button class="secondary download-recipients-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Download recipient CSV</button>
            <button class="ghost open-mail-session" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(ft.id)}">Open email draft</button>
          </div>
          <div class="session-checklist">
            <div class="checklist-label">Tasks for this session</div>
            ${mkItem('spreadsheet',       'Updated Excel spreadsheet with facilitator')}
            ${mkItem('participantEmail',   'Participant email sent')}
            ${mkItem('teamsInvite',        'Forwarded Teams meeting invitation to attendees')}
          </div>
        </div>`;
      }).join('')}
    </div>
  ` : '';

  const notBookedKey   = `notbooked:${group.id}`;
  const notBookedState = cl[notBookedKey] || {};
  const notBookedBlock = finalTimes.length > 0 && notBookedRespondents.length > 0 ? `
    <div class="notbooked-panel">
      <h4>Not booked into any session (${notBookedRespondents.length})</h4>
      <p class="subtle" style="margin:0 0 10px;font-size:13px">
        ${escapeHtml(notBookedRespondents.map((r) => r.user_name || r.user_email).join(', '))}
      </p>
      <div class="actions" style="margin-bottom:10px">
        <button class="secondary copy-notbooked-emails" type="button" data-group-id="${escapeHtml(group.id)}">Copy email addresses</button>
        <button class="secondary copy-notbooked-message" type="button" data-group-id="${escapeHtml(group.id)}">Copy email template</button>
      </div>
      <label class="checklist-item${notBookedState.email ? ' checklist-item--done' : ''}">
        <input type="checkbox" class="cl-check" data-key="${escapeHtml(notBookedKey)}" data-field="email"${notBookedState.email ? ' checked' : ''}>
        <span>'Not this time' email sent</span>
      </label>
    </div>
  ` : '';

  const extraAttendeesBlock = finalTimes.length > 0 ? renderExtraAttendeesPanel(group, primaryRespondents) : '';
  const conflictsBlock = finalTimes.length > 0 ? renderConflictsPanel(group, finalTimes) : '';

  groupDetailEl.innerHTML = `
    <div class="group-detail-meta">
      <span class="badge neutral">${primaryRespondents.length} respondent${primaryRespondents.length === 1 ? '' : 's'} of ${total || '?'} in group</span>
      ${group.description ? `<span class="subtle">${escapeHtml(group.description)}</span>` : ''}
    </div>
    <table class="slot-table">
      <thead>
        <tr>
          <th>Slot</th>
          <th>Date &amp; time</th>
          <th>Availability</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${timesHtml}</tbody>
    </table>
    <div class="final-form" style="margin-top:16px">
      <label>
        <span class="meta-line">Location</span>
        <input type="text" id="location-${escapeHtml(group.id)}" value="${escapeHtml(finalTime?.final_location || APP.defaultLocation)}">
      </label>
      <label>
        <span class="meta-line">Note for invite</span>
        <textarea id="note-${escapeHtml(group.id)}">${escapeHtml(finalTime?.final_note || '')}</textarea>
      </label>
    </div>
    ${finalBlock}
    ${notBookedBlock}
    ${conflictsBlock}
    ${extraAttendeesBlock}
  `;

  wireGroupDetailActions(group);
}

function renderConflictsPanel(group, finalTimes) {
  if (!finalTimes.length) return '';
  const allGroups = groupModels();

  const sections = finalTimes.map((finalTime) => {
    const overlapping = allGroups
      .filter((g) => g.id !== group.id)
      .flatMap((g) => {
        const slot = g.times.find((t) => t.id === finalTime.id);
        const availHere = Number(slot?.available_count || 0);
        if (availHere === 0) return [];
        const gTotal = Number(g.total || 0);
        const bestSlot = g.times.filter((t) => !t.is_final).reduce((best, t) =>
          Number(t.available_count || 0) > Number(best?.available_count || 0) ? t : best, null);
        const bestAvail = Number(bestSlot?.available_count || 0);
        const hasBetter = bestSlot && bestSlot.id !== finalTime.id && bestAvail > availHere;
        const alreadyFinalised = g.final_sessions_count > 0;
        return [{ g, availHere, gTotal, bestSlot, bestAvail, hasBetter, alreadyFinalised }];
      });

    if (overlapping.length === 0) return '';

    const rows = overlapping.map(({ g, availHere, gTotal, bestSlot, bestAvail, hasBetter, alreadyFinalised }) => {
      const statusBadge = alreadyFinalised
        ? `<span class="badge neutral">Already finalised</span>`
        : hasBetter
          ? `<span class="conflict-better">Better option: ${escapeHtml(bestSlot.label)} (${bestAvail}/${gTotal})</span>`
          : `<span class="conflict-clash">No better slot — this is their best</span>`;
      return `
        <div class="conflict-row">
          <span class="conflict-name">${escapeHtml(g.name)}</span>
          <span class="conflict-avail">${availHere}/${gTotal} available here</span>
          ${statusBadge}
        </div>`;
    }).join('');

    return `<div style="margin-bottom:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${escapeHtml(finalTime.label)}</div>
      ${rows}
    </div>`;
  }).filter(Boolean).join('');

  if (!sections) return '';

  return `
    <div class="conflicts-panel">
      <h3>Other groups available at confirmed times</h3>
      <p class="subtle" style="margin:0 0 10px">Check whether these groups have a better alternative before locking your choices.</p>
      ${sections}
    </div>`;
}

function renderExtraAttendeesPanel(group, primaryRespondents) {
  const extras = extraAttendees.get(group.id) || [];
  const primaryEmails = new Set(primaryRespondents.map((r) => r.user_email.toLowerCase()));
  const addedEmails = new Set(extras.map((e) => e.email.toLowerCase()));

  const candidates = responses
    .filter((r) => r.group_id !== group.id
      && !primaryEmails.has(r.user_email.toLowerCase())
      && !addedEmails.has(r.user_email.toLowerCase()))
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));

  const extrasList = extras.length > 0 ? `
    <ul class="extras-list">
      ${extras.map((e) => `
        <li>
          <span class="extra-info">
            <strong>${escapeHtml(e.name || e.email)}</strong>
            <span class="subtle"> — ${escapeHtml(e.email)}</span>
          </span>
          <button class="ghost remove-extra" type="button" data-group-id="${escapeHtml(group.id)}" data-email="${escapeHtml(e.email)}">Remove</button>
        </li>
      `).join('')}
    </ul>
  ` : '<p class="subtle" style="margin:6px 0 10px">None added yet.</p>';

  const addForm = candidates.length > 0 ? `
    <div class="add-extra-form">
      <select id="extra-candidate-${escapeHtml(group.id)}">
        <option value="">Select person to add…</option>
        ${candidates.map((r) => `
          <option value="${escapeHtml(r.user_email)}" data-name="${escapeHtml(r.user_name || '')}">
            ${escapeHtml(r.user_name || r.user_email)} — ${escapeHtml(r.group_name)}
          </option>
        `).join('')}
      </select>
      <button class="secondary add-extra" type="button" data-group-id="${escapeHtml(group.id)}">Add to session</button>
    </div>
  ` : '<p class="subtle" style="margin:6px 0">No other respondents to add.</p>';

  return `
    <div class="extra-attendees-panel">
      <h3>Extra attendees from other groups</h3>
      <p class="subtle" style="margin:0 0 8px;font-size:13px">These people are included in email invites and exports for this session.</p>
      ${extrasList}
      ${addForm}
    </div>
  `;
}

function wireGroupDetailActions(group) {
  groupDetailEl.querySelectorAll('.set-final').forEach((btn) => {
    btn.addEventListener('click', () => addFinalSession(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.remove-final').forEach((btn) => {
    btn.addEventListener('click', () => removeFinalSession(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.copy-names-session').forEach((btn) => {
    btn.addEventListener('click', () => copySessionNames(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.copy-emails-session').forEach((btn) => {
    btn.addEventListener('click', () => copySessionEmails(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.copy-message-session').forEach((btn) => {
    btn.addEventListener('click', () => copySessionMessage(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.copy-forward-note-session').forEach((btn) => {
    btn.addEventListener('click', () => copyForwardNote(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.download-ics-session').forEach((btn) => {
    btn.addEventListener('click', () => downloadSessionIcs(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.download-recipients-session').forEach((btn) => {
    btn.addEventListener('click', () => downloadSessionRecipients(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.open-mail-session').forEach((btn) => {
    btn.addEventListener('click', () => openSessionMailDraft(btn.dataset.groupId, btn.dataset.timeId));
  });
  // Checklist checkboxes — persist to localStorage, toggle strikethrough immediately
  groupDetailEl.querySelectorAll('.cl-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      setChecklistItem(cb.dataset.key, cb.dataset.field, cb.checked);
      cb.closest('.checklist-item')?.classList.toggle('checklist-item--done', cb.checked);
    });
  });

  groupDetailEl.querySelectorAll('.copy-notbooked-emails').forEach((btn) => {
    btn.addEventListener('click', () => copyNotBookedEmails(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.copy-notbooked-message').forEach((btn) => {
    btn.addEventListener('click', () => copyNotBookedMessage(btn.dataset.groupId));
  });

  groupDetailEl.querySelectorAll('.remove-extra').forEach((btn) => {
    btn.addEventListener('click', () => removeExtraAttendee(btn.dataset.groupId, btn.dataset.email));
  });
  groupDetailEl.querySelectorAll('.add-extra').forEach((btn) => {
    btn.addEventListener('click', () => {
      const select = document.getElementById(`extra-candidate-${btn.dataset.groupId}`);
      const email = select?.value;
      const name = select?.selectedOptions[0]?.dataset.name || '';
      if (email) addExtraAttendee(btn.dataset.groupId, email, name || null);
    });
  });
}

function renderRespondents() {
  const q = searchTerm.toLowerCase();
  const filtered = responses.filter((row) => !q
    || (row.user_name || '').toLowerCase().includes(q)
    || (row.user_email || '').toLowerCase().includes(q)
    || (row.group_name || '').toLowerCase().includes(q));

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (respondentSort.col) {
      case 'name':      cmp = sortName(a).localeCompare(sortName(b)); break;
      case 'email':     cmp = (a.user_email || '').localeCompare(b.user_email || ''); break;
      case 'group':     cmp = (a.group_name || '').localeCompare(b.group_name || '') || sortName(a).localeCompare(sortName(b)); break;
      case 'available': cmp = (b.available_time_option_ids?.length || 0) - (a.available_time_option_ids?.length || 0); break;
      case 'updated':   cmp = new Date(b.updated_at) - new Date(a.updated_at); break;
    }
    return respondentSort.dir === 'asc' ? cmp : -cmp;
  });

  const countLabel = $('#respondents-count-label');
  if (countLabel) countLabel.textContent = `— ${sorted.length} respondent${sorted.length === 1 ? '' : 's'}`;

  if (sorted.length === 0) {
    respondentTableEl.innerHTML = '<p class="empty" style="padding:14px">No respondents match.</p>';
    return;
  }

  const sortTh = (col, label) => {
    const active = respondentSort.col === col;
    const arrow = active ? (respondentSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${active ? ' sort-active' : ''}" data-col="${col}">${label}${arrow}</th>`;
  };

  respondentTableEl.innerHTML = `
    <table>
      <thead>
        <tr>
          ${sortTh('name', 'Name')}
          ${sortTh('email', 'Email')}
          ${sortTh('group', 'Group')}
          ${sortTh('available', 'Available')}
          ${sortTh('updated', 'Updated')}
        </tr>
      </thead>
      <tbody>
        ${sorted.map((row) => `
          <tr>
            <td>${escapeHtml(row.user_name || '')}</td>
            <td>${escapeHtml(row.user_email)}</td>
            <td>${escapeHtml(row.group_name)}</td>
            <td>${row.available_time_option_ids?.length || 0}</td>
            <td class="subtle">${new Date(row.updated_at).toLocaleString('en-NZ')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  respondentTableEl.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      if (respondentSort.col === th.dataset.col) {
        respondentSort.dir = respondentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        respondentSort.col = th.dataset.col;
        respondentSort.dir = 'asc';
      }
      renderRespondents();
    });
  });
}

function renderSuggestions() {
  const el = $('#suggestions-body');
  if (!el) return;

  const groups = groupModels();
  const HALF_HOUR = 30 * 60 * 1000;

  // All confirmed start-times across every group (for back-to-back warning)
  const confirmedStartMs = [];
  for (const g of groups) {
    for (const t of g.times) {
      if (t.is_final) confirmedStartMs.push(new Date(t.starts_at).getTime());
    }
  }

  const rows = groups.map((group) => {
    const groupRespondents = responses.filter((r) => r.group_id === group.id);
    if (groupRespondents.length === 0) return null;

    // Emails already covered by any confirmed session for this group
    const coveredEmails = new Set();
    for (const time of group.times) {
      if (!time.is_final) continue;
      for (const r of groupRespondents) {
        if (r.available_time_option_ids?.includes(time.id)) {
          coveredEmails.add(r.user_email.toLowerCase());
        }
      }
    }

    const uncovered = groupRespondents.filter((r) => !coveredEmails.has(r.user_email.toLowerCase()));

    if (uncovered.length === 0) {
      return { group, allCovered: true };
    }

    // For each non-final slot, count uncovered people who can attend
    const takenIds = takenByOtherGroupsTimeIds(group.id);
    const options = [];

    for (const time of group.times) {
      if (time.is_final) continue;
      const available = uncovered.filter((r) => r.available_time_option_ids?.includes(time.id));
      if (available.length < 2) continue;

      const startMs = new Date(time.starts_at).getTime();
      const isNear  = confirmedStartMs.some((ct) => { const d = Math.abs(startMs - ct); return d > 0 && d <= HALF_HOUR; });
      const isTaken = takenIds.has(time.id);

      options.push({ time, available, isTaken, isNear });
    }

    // Best first: non-taken, non-near, then most available
    options.sort((a, b) => {
      const score = (x) => (x.isTaken ? 200 : 0) + (x.isNear ? 20 : 0) - x.available.length;
      return score(a) - score(b);
    });

    return { group, allCovered: false, uncovered, options: options.slice(0, 3) };
  }).filter(Boolean);

  if (rows.length === 0) {
    el.innerHTML = '<p class="empty" style="padding:14px">No respondent data loaded.</p>';
    return;
  }

  // Separate groups needing action from fully-covered ones
  const needsAction = rows.filter((r) => !r.allCovered);
  const fullyCovered = rows.filter((r) => r.allCovered);

  const suggHtml = needsAction.map(({ group, uncovered, options }) => {
    const uncoveredNames = uncovered.map((r) => firstName(r.user_name || r.user_email));

    const slotsHtml = options.length === 0
      ? `<div class="sugg-no-slot">No slot has ≥ 2 of these people available together — may need individual outreach.</div>`
      : options.map((opt, i) => {
          const availNames  = opt.available.map((r) => firstName(r.user_name || r.user_email));
          const stillOut    = uncovered.filter((r) => !opt.available.some((a) => a.user_email === r.user_email));
          const stillNames  = stillOut.map((r) => firstName(r.user_name || r.user_email));
          const warnings    = [
            opt.isTaken ? '<span class="badge neutral" title="Another group has confirmed this slot">Slot taken</span>' : '',
            opt.isNear  ? '<span class="badge neutral" title="Within 30 min of a confirmed session">Back-to-back risk</span>' : '',
          ].filter(Boolean).join(' ');
          return `
            <div class="sugg-slot${i === 0 ? ' sugg-slot--best' : ''}">
              <span class="sugg-slot-rank">${i === 0 ? '★ Best' : `Option ${i + 1}`}</span>
              <span class="sugg-slot-time">${escapeHtml(opt.time.label)}</span>
              <span class="sugg-slot-detail">${escapeHtml(formatDateRange(opt.time.starts_at, opt.time.ends_at))}</span>
              ${warnings}
              <div class="sugg-names-yes">✓ ${escapeHtml(availNames.join(', '))} (${opt.available.length} of ${uncovered.length} uncovered)</div>
              ${stillNames.length
                ? `<div class="sugg-names-out">Still out after this: ${escapeHtml(stillNames.join(', '))}</div>`
                : `<div class="sugg-names-yes">All uncovered people included ✓</div>`}
            </div>`;
        }).join('');

    return `
      <div class="sugg-row">
        <div class="sugg-group-header">
          <span class="sugg-group-name">${escapeHtml(group.name)}</span>
          <span class="sugg-uncovered-names">${uncovered.length} not yet scheduled: ${escapeHtml(uncoveredNames.join(', '))}</span>
        </div>
        ${slotsHtml}
      </div>`;
  }).join('');

  const coveredHtml = fullyCovered.map(({ group }) => `
    <div class="sugg-row sugg-row--covered">
      <span class="sugg-group-name">${escapeHtml(group.name)}</span>
      <span class="badge good">All covered</span>
    </div>`).join('');

  el.innerHTML = needsAction.length === 0
    ? '<p class="empty" style="padding:14px">🎉 All respondents are covered by confirmed sessions.</p>'
    : suggHtml + (fullyCovered.length ? `<div style="border-top:2px solid var(--line);margin-top:4px">${coveredHtml}</div>` : '');
}

function renderSubmitForm() {
  const submitEl = $('#section-submit-body');
  if (!submitEl) return;

  // Preserve current field values across re-renders (e.g. after data refresh)
  const savedName    = $('#sr-name')?.value  ?? '';
  const savedEmail   = $('#sr-email')?.value ?? '';
  const savedGroup   = $('#sr-group')?.value ?? '';
  const savedChecked = new Set([...document.querySelectorAll('.submit-slot-cb:checked')].map((cb) => cb.value));
  const savedNotice  = $('#sr-notice')?.textContent ?? '';

  const groups = groupModels();

  const groupOptions = groups.map((g) =>
    `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`
  ).join('');

  // Build slot checkboxes grouped by calendar day
  const byDay = new Map();
  for (const t of timeOptions) {
    const day = new Date(t.starts_at).toLocaleDateString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Pacific/Auckland',
    });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const slotsHtml = [...byDay.entries()].map(([day, slots]) => `
    <div class="submit-day-group">
      <div class="submit-day-label">${escapeHtml(day)}</div>
      ${slots.map((t) => `
        <label class="submit-slot-row">
          <input type="checkbox" class="submit-slot-cb" value="${escapeHtml(t.id)}">
          <span>${escapeHtml(t.label)}</span>
          <span class="submit-slot-time">${escapeHtml(formatDateRange(t.starts_at, t.ends_at))}</span>
        </label>
      `).join('')}
    </div>
  `).join('');

  submitEl.innerHTML = `
    <form id="submit-response-form" style="max-width:600px">
      <p class="subtle" style="margin:0 0 14px">
        Type an email address and tab away — if they've already responded, the form pre-fills so you can update their choices.
        If they haven't signed up yet, a placeholder account is created automatically.
      </p>
      <div id="sr-notice" class="sr-notice" style="display:none"></div>
      <div class="submit-fields">
        <label>
          <span class="meta-line">Email address</span>
          <input type="email" id="sr-email" placeholder="jane.smith@example.com" required autocomplete="off">
        </label>
        <label>
          <span class="meta-line">Full name</span>
          <input type="text" id="sr-name" placeholder="Jane Smith" required>
        </label>
      </div>
      <label style="display:block;margin-bottom:16px">
        <span class="meta-line">Focus group</span>
        <select id="sr-group">${groupOptions}</select>
      </label>
      <div style="margin-bottom:8px">
        <span class="meta-line" style="font-weight:600">Tick the slots they are available for</span>
        <button type="button" id="sr-check-all" class="ghost" style="font-size:12px;margin-left:10px">All</button>
        <button type="button" id="sr-uncheck-all" class="ghost" style="font-size:12px">None</button>
      </div>
      ${slotsHtml.length ? `<div id="sr-slots">${slotsHtml}</div>` : '<p class="subtle">No time slots found — add some first.</p>'}
      <div style="margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button type="submit" class="primary" id="sr-submit-btn">Save response</button>
        <button type="button" class="ghost" id="sr-clear-btn">Clear form</button>
        <span id="sr-save-status" class="subtle" style="font-size:13px"></span>
      </div>
    </form>
  `;

  // Restore preserved values
  if (savedEmail)  $('#sr-email').value = savedEmail;
  if (savedName)   $('#sr-name').value  = savedName;
  if (savedGroup && $('#sr-group')) $('#sr-group').value = savedGroup;
  document.querySelectorAll('.submit-slot-cb').forEach((cb) => {
    if (savedChecked.has(cb.value)) cb.checked = true;
  });
  if (savedNotice) {
    $('#sr-notice').textContent = savedNotice;
    $('#sr-notice').style.display = '';
  }

  // Email blur → auto-fill from existing respondent
  $('#sr-email').addEventListener('blur', () => {
    const email = $('#sr-email').value.trim().toLowerCase();
    if (!email) return;
    const existing = responses.find((r) => r.user_email.toLowerCase() === email);
    if (!existing) return;

    $('#sr-name').value = existing.user_name || '';
    const groupSel = $('#sr-group');
    if (groupSel) groupSel.value = existing.group_id;
    document.querySelectorAll('.submit-slot-cb').forEach((cb) => {
      cb.checked = existing.available_time_option_ids?.includes(cb.value) ?? false;
    });
    const notice = $('#sr-notice');
    notice.textContent = `Existing response loaded for ${existing.user_name || email} (${existing.group_name}) — edit and save to update.`;
    notice.style.display = '';
  });

  // Clear notice when email changes
  $('#sr-email').addEventListener('input', () => {
    $('#sr-notice').style.display = 'none';
  });

  // All / None buttons
  $('#sr-check-all').addEventListener('click', () => {
    document.querySelectorAll('.submit-slot-cb').forEach((cb) => { cb.checked = true; });
  });
  $('#sr-uncheck-all').addEventListener('click', () => {
    document.querySelectorAll('.submit-slot-cb').forEach((cb) => { cb.checked = false; });
  });

  // Clear form
  $('#sr-clear-btn').addEventListener('click', () => {
    $('#submit-response-form').reset();
    $('#sr-notice').style.display = 'none';
    $('#sr-save-status').textContent = '';
  });

  // Submit
  $('#submit-response-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name       = $('#sr-name').value.trim();
    const email      = $('#sr-email').value.trim();
    const groupId    = $('#sr-group').value;
    const available  = [...document.querySelectorAll('.submit-slot-cb:checked')].map((cb) => cb.value);
    await submitResponse(name, email, groupId, available);
  });
}

async function submitResponse(name, email, groupId, availableIds) {
  const btn    = $('#sr-submit-btn');
  const status = $('#sr-save-status');
  btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const { data, error } = await SB.rpc('admin_submit_response', {
      p_email:               email,
      p_name:                name,
      p_group_id:            groupId,
      p_available_time_ids:  availableIds,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData(); // re-renders everything including the form (values preserved)
    toast(`Response saved for ${name}.`, 'success');
    if (status) status.textContent = `✓ Saved at ${new Date().toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    console.error(err);
    toast('Could not save response.', 'error');
    if (status) status.textContent = `Error: ${escapeHtml(err.message)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function addFinalSession(groupId, timeId) {
  const location = document.getElementById(`location-${groupId}`)?.value?.trim() || APP.defaultLocation;
  const note = document.getElementById(`note-${groupId}`)?.value?.trim() || '';
  try {
    const { data, error } = await SB.rpc('admin_add_group_final_session', {
      p_group_id: groupId,
      p_time_option_id: timeId,
      p_location: location,
      p_note: note,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData();
    toast('Session confirmed.', 'success');
  } catch (error) {
    console.error(error);
    toast('Could not confirm the session.', 'error');
  }
}

async function removeFinalSession(groupId, timeId) {
  try {
    const { data, error } = await SB.rpc('admin_remove_group_final_session', {
      p_group_id: groupId,
      p_time_option_id: timeId,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData();
    toast('Session removed.', 'success');
  } catch (error) {
    console.error(error);
    toast('Could not remove the session.', 'error');
  }
}

async function addExtraAttendee(groupId, email, name) {
  try {
    const { data, error } = await SB.rpc('admin_add_extra_attendee', {
      p_group_id: groupId,
      p_user_email: email,
      p_user_name: name || null,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData();
    toast('Extra attendee added.', 'success');
  } catch (error) {
    console.error(error);
    toast('Could not add attendee.', 'error');
  }
}

async function removeExtraAttendee(groupId, email) {
  try {
    const { data, error } = await SB.rpc('admin_remove_extra_attendee', {
      p_group_id: groupId,
      p_user_email: email,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData();
    toast('Extra attendee removed.', 'success');
  } catch (error) {
    console.error(error);
    toast('Could not remove attendee.', 'error');
  }
}

function buildMessage(group) {
  const finalTimes = finalTimesForGroup(group);
  if (!finalTimes.length) return '';

  const timeText = finalTimes.length === 1
    ? formatDateRange(finalTimes[0].starts_at, finalTimes[0].ends_at)
    : finalTimes.map((t, i) => `session ${i + 1}: ${formatDateRange(t.starts_at, t.ends_at)}`).join(', and ');

  const note = finalTimes[0]?.final_note || '';
  const location = finalTimes[0]?.final_location || APP.defaultLocation;

  return [
    'Kia ora,',
    '',
    'Thank you very much for being available for a focus group about Dio\'s school information system project.',
    '',
    `Your focus group session for ${group.name} has been scheduled for ${timeText}.${note ? ' ' + note : ''}`,
    '',
    `This will be a ${location} and I\'ll send you a calendar invitation shortly with joining details. The session will be facilitated by Damien Evans from Centorrino Technologies (an organisation working with Dio on our system refresh project). It will be transcribed so your comments can be accurately reflected. The transcript will be shared with me, but when insights are shared or reported on, comments won't be linked back to individuals.`,
    '',
    'I won\'t be in the session but if you have any questions at all, please reach out to me anytime through a Teams message, email, or by phone as below.',
    '',
    '',
    'Kind regards,',
    '',
    'Kelly',
  ].join('\n');
}

function copyGroupNames(groupId) {
  const names = responsesForGroup(groupId).map((row) => row.user_name || row.user_email).join('; ');
  copyText(names, 'Names copied.');
}

function copyGroupEmails(groupId) {
  const emails = responsesForGroup(groupId).map((row) => row.user_email).join('; ');
  copyText(emails, 'Emails copied.');
}

function copyGroupMessage(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  copyText(buildMessage(group), 'Message copied.');
}

function copyNotBookedEmails(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const confirmed = new Set(
    group.times.filter((t) => t.is_final).flatMap((t) =>
      responses.filter((r) => r.group_id === groupId && r.available_time_option_ids?.includes(t.id)).map((r) => r.user_email.toLowerCase())
    )
  );
  const notBooked = responses
    .filter((r) => r.group_id === groupId && !confirmed.has(r.user_email.toLowerCase()))
    .map((r) => r.user_email);
  if (notBooked.length === 0) { toast('Everyone in this group is booked into a session.', 'info'); return; }
  copyText(notBooked.join('; '), 'Email addresses copied.');
}

function copyNotBookedMessage(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const message = [
    'Kia ora,', '',
    `Thank you for completing the availability survey for the ${group.name} focus group.`,
    '',
    'Unfortunately we weren\'t able to include you in a scheduled session this time around. We may need to run additional sessions later in the process, and if so we\'ll be in touch to see if you\'re available.',
    '',
    'Thank you for your willingness to participate — it\'s very much appreciated.',
    '',
    '', 'Kind regards,', '', 'Kelly',
  ].join('\n');
  copyText(message, 'Email template copied.');
}

// ── Per-session actions ───────────────────────────────────────────────────────

function copySessionNames(groupId, timeId) {
  const names = responsesForSession(groupId, timeId).map((r) => r.user_name || r.user_email).join('; ');
  copyText(names, 'Names copied.');
}

function copySessionEmails(groupId, timeId) {
  const emails = responsesForSession(groupId, timeId).map((r) => r.user_email).join('; ');
  copyText(emails, 'Emails copied.');
}

function buildMessageForSession(group, ft) {
  const note     = ft.final_note     || '';
  const location = ft.final_location || APP.defaultLocation;
  return [
    'Kia ora,', '',
    'Thank you very much for being available for a focus group about Dio\'s school information system project.', '',
    `Your focus group session for ${group.name} has been scheduled for ${formatDateRange(ft.starts_at, ft.ends_at)}.${note ? ' ' + note : ''}`, '',
    `This will be a ${location} and I'll send you a calendar invitation shortly with joining details. The session will be facilitated by Damien Evans from Centorrino Technologies (an organisation working with Dio on our system refresh project). It will be transcribed so your comments can be accurately reflected. The transcript will be shared with me, but when insights are shared or reported on, comments won't be linked back to individuals.`, '',
    'I won\'t be in the session but if you have any questions at all, please reach out to me anytime through a Teams message, email, or by phone as below.',
    '', '', 'Kind regards,', '', 'Kelly',
  ].join('\n');
}

function copyForwardNote(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  copyText(
    `Please use these meeting details for the ${group.name} focus group about Dio's information systems. Thanks!`,
    'Forwarding note copied.',
  );
}

function copySessionMessage(groupId, timeId) {
  const group = groupById(groupId);
  if (!group) return;
  const ft = group.times.find((t) => t.id === timeId);
  if (!ft) return;
  copyText(buildMessageForSession(group, ft), 'Message copied.');
}

function buildSessionIcs(group, ft) {
  const recipients = responsesForSession(group.id, ft.id);
  const location   = ft.final_location || APP.defaultLocation;
  const description = [
    `Group: ${group.name}`,
    ft.final_note ? `Note: ${ft.final_note}` : '',
    `Organised by ${APP.organisationName}`,
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dio Focus Group Scheduler//EN',
    'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${group.id}-${ft.id}@focus-group-scheduler`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(ft.starts_at)}`,
    `DTEND:${utcStamp(ft.ends_at)}`,
    `SUMMARY:${icsEscape(`Focus group: ${group.name}`)}`,
    `LOCATION:${icsEscape(location)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `ORGANIZER;CN=${icsEscape(APP.organisationName)}:mailto:${session.user.email}`,
    ...recipients.map((r) =>
      `ATTENDEE;CN=${icsEscape(r.user_name || r.user_email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${r.user_email}`
    ),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n');
}

function downloadSessionIcs(groupId, timeId) {
  const group = groupById(groupId);
  if (!group) return;
  const ft = group.times.find((t) => t.id === timeId);
  if (!ft) { toast('Session not found.', 'error'); return; }
  const ics = buildSessionIcs(group, ft);
  downloadText(`focus-group-${group.id}-${ft.label.replace(/[^a-z0-9]/gi, '-')}.ics`, ics, 'text/calendar;charset=utf-8');
  toast('Calendar file downloaded.', 'success');
}

function downloadSessionRecipients(groupId, timeId) {
  const group = groupById(groupId);
  if (!group) return;
  const ft = group.times.find((t) => t.id === timeId);
  const headers = ['Name', 'Email', 'Group', 'Available', 'Unavailable'];
  const rows = responsesForSession(groupId, timeId).map((r) => [
    r.user_name, r.user_email, r.group_name,
    (r.available_labels || []).join('; '),
    (r.unavailable_labels || []).join('; '),
  ]);
  const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const slug = ft ? ft.label.replace(/[^a-z0-9]/gi, '-').toLowerCase() : timeId.slice(0, 8);
  downloadText(`focus-group-${group.id}-${slug}-recipients.csv`, `﻿${csv}`, 'text/csv;charset=utf-8');
}

function openSessionMailDraft(groupId, timeId) {
  const group = groupById(groupId);
  if (!group) return;
  const ft = group.times.find((t) => t.id === timeId);
  if (!ft) return;
  const to   = responsesForSession(groupId, timeId).map((r) => encodeURIComponent(r.user_email)).join(',');
  const subj = `Focus group session: ${group.name}`;
  const body = `${buildMessageForSession(group, ft)}\n\nCalendar file: download the .ics from the admin page and attach it before sending.`;
  window.location.href = `mailto:${to}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
}

function buildGroupIcs(group) {
  const time = finalTimeForGroup(group);
  if (!time) return '';
  const recipients = responsesForGroup(group.id);
  const location = group.final_location || APP.defaultLocation;
  const description = [
    `Group: ${group.name}`,
    group.final_note ? `Note: ${group.final_note}` : '',
    `Organised by ${APP.organisationName}`,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dio Focus Group Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${group.id}-${time.id}@focus-group-scheduler`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(time.starts_at)}`,
    `DTEND:${utcStamp(time.ends_at)}`,
    `SUMMARY:${icsEscape(`Focus group: ${group.name}`)}`,
    `LOCATION:${icsEscape(location)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `ORGANIZER;CN=${icsEscape(APP.organisationName)}:mailto:${session.user.email}`,
    ...recipients.map((row) =>
      `ATTENDEE;CN=${icsEscape(row.user_name || row.user_email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${row.user_email}`
    ),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n');
}

function downloadGroupIcs(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const ics = buildGroupIcs(group);
  if (!ics) { toast('Set a final time first.', 'error'); return; }
  downloadText(`focus-group-${group.id}.ics`, ics, 'text/calendar;charset=utf-8');
  toast('Calendar file downloaded.', 'success');
}

function downloadRecipients(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const headers = ['Name', 'Email', 'Group', 'Available', 'Unavailable'];
  const rows = responsesForGroup(groupId).map((row) => [
    row.user_name,
    row.user_email,
    row.group_name,
    (row.available_labels || []).join('; '),
    (row.unavailable_labels || []).join('; '),
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadText(`focus-group-${group.id}-recipients.csv`, `﻿${csv}`, 'text/csv;charset=utf-8');
}

function openMailDraft(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const recipients = responsesForGroup(groupId)
    .map((row) => encodeURIComponent(row.user_email))
    .join(',');
  const subject = `Focus group session: ${group.name}`;
  const body = `${buildMessage(group)}\n\nCalendar file: download the .ics from the admin page and attach it before sending.`;
  window.location.href = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function exportResponsesCsv() {
  const headers = ['Name', 'Email', 'Group', 'Available', 'Unavailable', 'Updated'];
  const rows = [...responses]
    .sort((a, b) => (a.group_name || '').localeCompare(b.group_name || '') || sortName(a).localeCompare(sortName(b)))
    .map((row) => [
      row.user_name,
      row.user_email,
      row.group_name,
      (row.available_labels || []).join('; '),
      (row.unavailable_labels || []).join('; '),
      row.updated_at,
    ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadText(`focus-group-responses-${stamp}.csv`, `﻿${csv}`, 'text/csv;charset=utf-8');
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadData() {
  const [summaryR, responsesR, extrasR] = await Promise.all([
    SB.rpc('admin_get_availability_summary'),
    SB.rpc('admin_get_all_responses'),
    SB.rpc('admin_get_extra_attendees'),
  ]);

  if (summaryR.error) throw summaryR.error;
  if (responsesR.error) throw responsesR.error;
  // Extra attendees RPC may not exist yet if DB migration hasn't run — degrade gracefully.
  if (extrasR.error && !extrasR.error.message?.includes('schema cache')) throw extrasR.error;

  summaryRows = summaryR.data || [];
  responses = responsesR.data || [];

  // Derive unique time options from summary rows (cross-join ensures all appear)
  const toMap = new Map();
  for (const row of summaryRows) {
    if (!toMap.has(row.time_option_id)) {
      toMap.set(row.time_option_id, {
        id: row.time_option_id,
        label: row.time_label,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
      });
    }
  }
  timeOptions = [...toMap.values()].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  extraAttendees = new Map();
  for (const row of extrasR.data || []) {
    if (!extraAttendees.has(row.group_id)) extraAttendees.set(row.group_id, []);
    extraAttendees.get(row.group_id).push({ email: row.user_email, name: row.user_name, added_at: row.added_at });
  }

  render();
}

async function signOut() {
  await SB.auth.signOut();
  location.href = '/';
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  session = (await SB.auth.getSession()).data.session;
  if (!session) { location.href = '/'; return; }

  $('#admin-email').textContent = session.user.email;
  $('#signout-btn').addEventListener('click', signOut);
  $('#refresh-btn').addEventListener('click', async () => {
    await loadData();
    toast('Data refreshed.', 'success');
  });
  $('#export-responses-btn').addEventListener('click', exportResponsesCsv);
  $('#search').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim();
    if (searchTerm) $('#respondents-details').open = true;
    renderRespondents();
  });
  $('#group-select').addEventListener('change', (e) => {
    selectedGroupId = e.target.value;
    renderGroupDetail(selectedGroupId);
    renderSidebar();
  });

  $('#admin-sidebar').querySelectorAll('[data-scroll]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  try {
    await loadData();
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    loadingEl.classList.add('hidden');
    if (error.message?.includes('forbidden') || error.code === 'P0001') {
      notAdminEl.classList.remove('hidden');
      return;
    }
    loadingEl.classList.remove('hidden');
    loadingEl.innerHTML = `<p style="color:var(--red)">Could not load admin data: ${escapeHtml(error.message || error)}</p>`;
  }
}

main();
