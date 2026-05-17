import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SB = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const APP = { ...(window.APP_CONFIG || {}) };

const $ = (s) => document.querySelector(s);
const loadingEl = $('#loading');
const notAdminEl = $('#not-admin');
const contentEl = $('#cal-content');

// Ten visually distinct pastel palettes
const PALETTE = [
  { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a8a' },
  { bg: '#d1fae5', border: '#10b981', text: '#065f46' },
  { bg: '#fef3c7', border: '#f59e0b', text: '#78350f' },
  { bg: '#fee2e2', border: '#ef4444', text: '#7f1d1d' },
  { bg: '#ede9fe', border: '#8b5cf6', text: '#4c1d95' },
  { bg: '#fce7f3', border: '#ec4899', text: '#831843' },
  { bg: '#ccfbf1', border: '#14b8a6', text: '#134e4a' },
  { bg: '#ffedd5', border: '#f97316', text: '#7c2d12' },
  { bg: '#e0e7ff', border: '#6366f1', text: '#312e81' },
  { bg: '#ecfccb', border: '#84cc16', text: '#365314' },
];

let summaryRows = [];
let responses = [];
let confirmedSet = new Set();    // 'group_id:time_option_id'
let confirmedTimeIds = new Set(); // time_option_ids confirmed by ANY group

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function firstName(name) {
  return (name || '?').trim().split(/\s+/)[0];
}

// Returns a NZ-localised string using en-CA locale for ISO date (YYYY-MM-DD) sorting
function nzDateKey(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); // e.g. "2026-05-19"
}

function nzDayLabel(isoString) {
  return new Date(isoString).toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short',
  });
}

function nzTimeLabel(isoString) {
  return new Date(isoString).toLocaleTimeString('en-NZ', {
    timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit',
  });
}

function nzTimeMinutes(isoString) {
  // Convert to NZ local then extract HH*60+mm for row ordering
  const nz = new Date(new Date(isoString).toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  return nz.getHours() * 60 + nz.getMinutes();
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function loadData() {
  const [summaryR, responsesR, finalR] = await Promise.all([
    SB.rpc('admin_get_availability_summary'),
    SB.rpc('admin_get_all_responses'),
    SB.from('group_final_sessions').select('group_id, time_option_id'),
  ]);
  if (summaryR.error) throw summaryR.error;
  if (responsesR.error) throw responsesR.error;
  summaryRows = summaryR.data || [];
  responses = responsesR.data || [];
  confirmedSet = new Set((finalR.data || []).map((r) => `${r.group_id}:${r.time_option_id}`));
  confirmedTimeIds = new Set((finalR.data || []).map((r) => r.time_option_id));
}

// ─── Grid building ───────────────────────────────────────────────────────────

function buildGrid() {
  // Step 1: gather unique time options with sort keys
  const timeOptsMap = new Map(); // time_option_id → {dayKey, dayLabel, timeMinutes, timeLabel}
  for (const row of summaryRows) {
    if (!timeOptsMap.has(row.time_option_id)) {
      timeOptsMap.set(row.time_option_id, {
        dayKey:      nzDateKey(row.starts_at),   // YYYY-MM-DD for sorting
        dayLabel:    nzDayLabel(row.starts_at),  // "Mon 19 May"
        timeMinutes: nzTimeMinutes(row.starts_at),
        timeLabel:   nzTimeLabel(row.starts_at), // "10:00 am"
      });
    }
  }

  // Step 2: unique days (sorted) and unique times (sorted)
  const daysMap = new Map();   // dayLabel → dayKey
  const timesMap = new Map();  // timeMinutes → timeLabel
  for (const [, slot] of timeOptsMap) {
    daysMap.set(slot.dayLabel, slot.dayKey);
    timesMap.set(slot.timeMinutes, slot.timeLabel);
  }
  const uniqueDays  = [...daysMap.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([label]) => label);
  const uniqueTimes = [...timesMap.entries()].sort((a, b) => a[0] - b[0]).map(([m, l]) => ({ minutes: m, label: l }));

  // Step 3: cell lookup  day + timeMinutes → time_option_id
  const cellLookup = new Map();
  for (const [id, slot] of timeOptsMap) {
    cellLookup.set(`${slot.dayLabel}|${slot.timeMinutes}`, id);
  }

  // Step 4: group colour map (by appearance order, which reflects display_order)
  const groupOrder = [];
  const groupNameMap = new Map();
  for (const row of summaryRows) {
    if (!groupOrder.includes(row.group_id)) groupOrder.push(row.group_id);
    groupNameMap.set(row.group_id, row.group_name);
  }
  const groupColorMap = new Map(groupOrder.map((id, i) => [id, PALETTE[i % PALETTE.length]]));

  // Step 5a: pre-compute which emails are already in a confirmed session per group
  // (so we can dim blocks where everyone is already scheduled)
  const scheduledEmailsByGroup = new Map(); // group_id → Set<email>
  for (const entry of confirmedSet) {
    const colonIdx = entry.indexOf(':');
    const gId = entry.slice(0, colonIdx);
    const tId = entry.slice(colonIdx + 1);
    if (!scheduledEmailsByGroup.has(gId)) scheduledEmailsByGroup.set(gId, new Set());
    const target = scheduledEmailsByGroup.get(gId);
    for (const r of responses) {
      if (r.group_id === gId && r.available_time_option_ids?.includes(tId)) {
        target.add(r.user_email.toLowerCase());
      }
    }
  }

  // Step 5b: build set of confirmed slot start-times (ms) for proximity check
  const confirmedStartMs = new Set();
  for (const entry of confirmedSet) {
    const tId = entry.slice(entry.indexOf(':') + 1);
    const sr = summaryRows.find((r) => r.time_option_id === tId);
    if (sr) confirmedStartMs.add(new Date(sr.starts_at).getTime());
  }
  const HALF_HOUR_MS = 30 * 60 * 1000;

  // Step 5c: per-slot blocks (groups with at least 1 available person)
  const slotBlocks = new Map(); // time_option_id → [block, …]
  for (const row of summaryRows) {
    const avail = Number(row.available_count || 0);
    if (avail === 0) continue;

    if (!slotBlocks.has(row.time_option_id)) slotBlocks.set(row.time_option_id, []);

    const blockRespondents = responses.filter(
      (r) => r.group_id === row.group_id && r.available_time_option_ids?.includes(row.time_option_id),
    );
    const emails = blockRespondents.map((r) => r.user_email.toLowerCase());
    // Track per-person scheduled status so names can be individually styled
    const attendees = blockRespondents
      .map((r) => ({
        name:      firstName(r.user_name || r.user_email),
        scheduled: scheduledEmails.has(r.user_email.toLowerCase()),
      }))
      .sort((a, b) => a.scheduled - b.scheduled); // unscheduled names first

    const isConfirmed = confirmedSet.has(`${row.group_id}:${row.time_option_id}`);

    // "covered" — every person in this block is already in one of this group's confirmed sessions
    const scheduledEmails = scheduledEmailsByGroup.get(row.group_id) || new Set();
    const covered = !isConfirmed && emails.length > 0 && emails.every((e) => scheduledEmails.has(e));

    // "near" — slot starts within 30 min (exclusive) of any confirmed slot (back-to-back fatigue)
    const slotStartMs = new Date(row.starts_at).getTime();
    const near = !isConfirmed && [...confirmedStartMs].some((ct) => {
      const diff = Math.abs(slotStartMs - ct);
      return diff > 0 && diff <= HALF_HOUR_MS;
    });

    slotBlocks.get(row.time_option_id).push({
      group_id:   row.group_id,
      group_name: row.group_name,
      available:  avail,
      total:      Number(row.total_in_group || 0),
      attendees,
      color:      groupColorMap.get(row.group_id),
      confirmed:  isConfirmed,
      taken:      confirmedTimeIds.has(row.time_option_id) && !isConfirmed,
      covered,   // all people already in a confirmed session → redundant slot
      near,      // within 30 min of a confirmed slot → back-to-back risk
    });
  }

  return { uniqueDays, uniqueTimes, cellLookup, slotBlocks, groupColorMap, groupNameMap };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderLegend(groupColorMap, groupNameMap, filterGroupId = '') {
  $('#cal-legend').innerHTML =
    '<span class="cal-legend-label">Groups:</span>' +
    [...groupColorMap.entries()].map(([id, c]) => {
      const dimmed = filterGroupId && filterGroupId !== id;
      return `
        <div class="cal-legend-item" style="background:${c.bg};border-color:${c.border};opacity:${dimmed ? 0.35 : 1}">
          <span class="cal-legend-swatch" style="background:${c.bg};border-color:${c.border}"></span>
          <span style="color:${c.text};font-weight:600">${escapeHtml(groupNameMap.get(id) || id)}</span>
        </div>`;
    }).join('');
}

function populateGroupFilter(groupColorMap, groupNameMap) {
  const sel = $('#group-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All groups</option>' +
    [...groupColorMap.keys()].map((id) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(groupNameMap.get(id) || id)}</option>`
    ).join('');
  if (current) sel.value = current;
}

function renderCalendar() {
  const { uniqueDays, uniqueTimes, cellLookup, slotBlocks, groupColorMap, groupNameMap } = buildGrid();
  const filterGroupId = $('#group-filter').value;

  populateGroupFilter(groupColorMap, groupNameMap);
  renderLegend(groupColorMap, groupNameMap, filterGroupId);

  const thead = `<thead><tr>
    <th class="cal-corner"></th>
    ${uniqueDays.map((d) => `<th class="cal-day-header">${escapeHtml(d)}</th>`).join('')}
  </tr></thead>`;

  const tbody = `<tbody>${uniqueTimes.map(({ minutes, label }) => {
    const cells = uniqueDays.map((day) => {
      const slotId = cellLookup.get(`${day}|${minutes}`);
      const allBlocks = slotId ? (slotBlocks.get(slotId) || []) : [];
      const blocks = filterGroupId
        ? allBlocks.filter((b) => b.group_id === filterGroupId)
        : allBlocks;

      if (blocks.length === 0) return '<td class="cal-cell cal-cell--empty"></td>';

      const blockHtml = blocks
        // Sort: confirmed → normal → near → taken → covered (most to least useful)
        .sort((a, b) => {
          if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
          const rank = (x) => x.covered ? 4 : x.taken ? 3 : x.near ? 2 : 0;
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return b.available - a.available;
        })
        .map((b) => {
          const dimClass = b.confirmed    ? ' avail-block--confirmed'
                         : b.covered     ? ' avail-block--covered'
                         : b.taken       ? ' avail-block--taken'
                         : b.near        ? ' avail-block--near'
                         : '';
          const label = b.confirmed ? '<div class="block-confirmed">✓ Confirmed</div>'
                      : b.covered   ? '<div class="block-dim-label">Already scheduled</div>'
                      : b.taken     ? '<div class="block-dim-label">Slot taken</div>'
                      : b.near      ? '<div class="block-dim-label">Near confirmed slot</div>'
                      : '';
          return `
          <div class="avail-block${dimClass}"
               style="background:${b.color.bg};border-left-color:${b.color.border};color:${b.color.text}">
            <div class="block-header">
              <span class="block-group">${escapeHtml(b.group_name)}</span>
              <span class="block-count">${b.available}/${b.total}</span>
            </div>
            ${b.attendees.length ? `<div class="block-names">${
              b.attendees.map((a) => a.scheduled
                ? `<span class="name-scheduled">${escapeHtml(a.name)}</span>`
                : escapeHtml(a.name)
              ).join(', ')
            }</div>` : ''}
            ${label}
          </div>`;
        }).join('');

      return `<td class="cal-cell">${blockHtml}</td>`;
    }).join('');

    return `<tr class="cal-row"><td class="cal-time-label">${escapeHtml(label)}</td>${cells}</tr>`;
  }).join('')}</tbody>`;

  $('#cal-table').innerHTML = `<table class="cal-table">${thead}${tbody}</table>`;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  const session = (await SB.auth.getSession()).data.session;
  if (!session) { location.href = '/'; return; }

  $('#signout-btn').addEventListener('click', async () => {
    await SB.auth.signOut();
    location.href = '/';
  });

  try {
    await loadData();
    renderCalendar();
    $('#group-filter').addEventListener('change', renderCalendar);
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    loadingEl.classList.add('hidden');
    if (error.message?.includes('forbidden') || error.code === 'P0001') {
      notAdminEl.classList.remove('hidden');
    } else {
      loadingEl.textContent = `Could not load calendar: ${error.message}`;
      loadingEl.classList.remove('hidden');
    }
  }
}

main();
