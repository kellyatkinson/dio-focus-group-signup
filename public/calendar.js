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

  // Step 5: per-slot blocks (groups with at least 1 available person)
  const slotBlocks = new Map(); // time_option_id → [block, …]
  for (const row of summaryRows) {
    const avail = Number(row.available_count || 0);
    if (avail === 0) continue;

    if (!slotBlocks.has(row.time_option_id)) slotBlocks.set(row.time_option_id, []);

    const names = responses
      .filter((r) => r.group_id === row.group_id && r.available_time_option_ids?.includes(row.time_option_id))
      .map((r) => firstName(r.user_name || r.user_email));

    const isConfirmed = confirmedSet.has(`${row.group_id}:${row.time_option_id}`);
    slotBlocks.get(row.time_option_id).push({
      group_id:   row.group_id,
      group_name: row.group_name,
      available:  avail,
      total:      Number(row.total_in_group || 0),
      names,
      color:      groupColorMap.get(row.group_id),
      confirmed:  isConfirmed,
      // Slot is "taken" if another group has confirmed this time_option_id
      taken:      confirmedTimeIds.has(row.time_option_id) && !isConfirmed,
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
        // confirmed first, then non-taken by available count, taken last
        .sort((a, b) => {
          if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
          if (a.taken !== b.taken) return a.taken ? 1 : -1;
          return b.available - a.available;
        })
        .map((b) => `
          <div class="avail-block${b.confirmed ? ' avail-block--confirmed' : b.taken ? ' avail-block--taken' : ''}"
               style="background:${b.color.bg};border-left-color:${b.color.border};color:${b.color.text}">
            <div class="block-header">
              <span class="block-group">${escapeHtml(b.group_name)}</span>
              <span class="block-count">${b.available}/${b.total}</span>
            </div>
            ${b.names.length ? `<div class="block-names">${escapeHtml(b.names.join(', '))}</div>` : ''}
            ${b.confirmed ? '<div class="block-confirmed">✓ Confirmed</div>' : ''}
            ${b.taken ? '<div class="block-taken">Slot taken</div>' : ''}
          </div>`).join('');

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
