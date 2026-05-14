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
        final_time_option_id: row.final_time_option_id,
        final_location: row.final_location,
        final_note: row.final_note,
        finalised_at: row.finalised_at,
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
    });
  }
  return [...byGroup.values()];
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

function sortName(row) {
  const name = (row.user_name || '').trim().toLowerCase();
  const email = (row.user_email || '').toLowerCase();
  return name ? `${name}|${email}` : email;
}

function finalTimeForGroup(group) {
  return group.times.find((t) => t.id === group.final_time_option_id) || null;
}

function groupById(groupId) {
  return groupModels().find((g) => g.id === groupId) || null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render() {
  renderSummary();
  renderSidebar();
  renderTimeslotOverview();
  renderGroupSelector();
  renderGroupDetail(selectedGroupId);
  renderRespondents();
}

function renderSidebar() {
  const sidebarGroupsEl = $('#sidebar-groups');
  if (!sidebarGroupsEl) return;
  const groups = groupModels();
  sidebarGroupsEl.innerHTML = groups.map((g) => {
    const finalised = !!g.final_time_option_id;
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
    const isFinalised = !!group.final_time_option_id;
    const finalTime = finalTimeForGroup(group);

    const bestTime = isFinalised
      ? finalTime
      : group.times.reduce((best, t) => {
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

  summaryEl.innerHTML = `
    <div class="panel-header">
      <h2>Group readiness</h2>
      <span class="meta-line">${responses.length} respondent${responses.length === 1 ? '' : 's'} · ${groups.filter((g) => g.final_time_option_id).length}/${groups.length} finalised</span>
    </div>
    <div class="readiness-grid">${cards}</div>
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
      totals.set(row.time_option_id, { label: row.time_label, starts_at: row.starts_at, total: 0, bestGroup: '', bestCount: 0 });
    }
    const entry = totals.get(row.time_option_id);
    const n = Number(row.available_count || 0);
    entry.total += n;
    if (n > entry.bestCount) {
      entry.bestCount = n;
      entry.bestGroup = row.group_name;
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
          <th>Most interest from</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((row) => `
          <tr>
            <td>${escapeHtml(row.label)}</td>
            <td>
              <div class="bar-cell">
                <div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? Math.round((row.total / max) * 100) : 0}%"></div></div>
                <span>${row.total}</span>
              </div>
            </td>
            <td class="subtle">${row.total > 0 ? escapeHtml(row.bestGroup) : '—'}</td>
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
  const finalTime = finalTimeForGroup(group);
  const location = group.final_location || APP.defaultLocation;

  const sortedTimes = [...group.times].sort((a, b) => Number(b.available_count || 0) - Number(a.available_count || 0));
  const maxAvail = sortedTimes.length > 0 ? Number(sortedTimes[0].available_count || 0) : 1;

  const timesHtml = sortedTimes.map((time, index) => {
    const available = Number(time.available_count || 0);
    const unavailable = total - available;
    const pct = maxAvail > 0 ? Math.round((available / maxAvail) * 100) : 0;
    const isFinal = time.id === group.final_time_option_id;
    const isBest = index === 0 && available > 0;
    return `
      <tr class="${isFinal ? 'slot-final-row' : ''}">
        <td>${escapeHtml(time.label)}</td>
        <td class="subtle">${escapeHtml(formatDateRange(time.starts_at, time.ends_at))}</td>
        <td>
          <div class="bar-cell">
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="subtle">${available} yes${unavailable > 0 ? `, ${unavailable} no` : ''}</span>
          </div>
        </td>
        <td class="slot-actions">
          ${isBest ? '<span class="badge good">Best</span>' : ''}
          ${isFinal ? '<span class="badge good">Final</span>' : ''}
          <button class="secondary set-final" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(time.id)}" style="margin-left:6px">
            ${isFinal ? 'Update' : 'Set as final'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  const finalBlock = finalTime ? `
    <div class="notification-tools" style="margin-top:16px">
      <div><strong>Final:</strong> ${escapeHtml(formatDateRange(finalTime.starts_at, finalTime.ends_at))}</div>
      <div class="subtle">${escapeHtml(location)}${group.final_note ? ` — ${escapeHtml(group.final_note)}` : ''}</div>
      <div class="actions" style="margin-top:10px">
        <button class="secondary copy-names" type="button" data-group-id="${escapeHtml(group.id)}">Copy names</button>
        <button class="secondary copy-emails" type="button" data-group-id="${escapeHtml(group.id)}">Copy emails</button>
        <button class="secondary copy-message" type="button" data-group-id="${escapeHtml(group.id)}">Copy message</button>
        <button class="secondary download-ics" type="button" data-group-id="${escapeHtml(group.id)}">Download .ics</button>
        <button class="secondary download-recipients" type="button" data-group-id="${escapeHtml(group.id)}">Download recipient CSV</button>
        <button class="ghost open-mail" type="button" data-group-id="${escapeHtml(group.id)}">Open email draft</button>
      </div>
    </div>
  ` : '';

  const extraAttendeesBlock = finalTime ? renderExtraAttendeesPanel(group, primaryRespondents) : '';

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
        <input type="text" id="location-${escapeHtml(group.id)}" value="${escapeHtml(location)}">
      </label>
      <label>
        <span class="meta-line">Note for invite</span>
        <textarea id="note-${escapeHtml(group.id)}">${escapeHtml(group.final_note || '')}</textarea>
      </label>
    </div>
    ${finalBlock}
    ${extraAttendeesBlock}
  `;

  wireGroupDetailActions(group);
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
    btn.addEventListener('click', () => setFinalTime(btn.dataset.groupId, btn.dataset.timeId));
  });
  groupDetailEl.querySelectorAll('.copy-names').forEach((btn) => {
    btn.addEventListener('click', () => copyGroupNames(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.copy-emails').forEach((btn) => {
    btn.addEventListener('click', () => copyGroupEmails(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.copy-message').forEach((btn) => {
    btn.addEventListener('click', () => copyGroupMessage(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.download-ics').forEach((btn) => {
    btn.addEventListener('click', () => downloadGroupIcs(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.download-recipients').forEach((btn) => {
    btn.addEventListener('click', () => downloadRecipients(btn.dataset.groupId));
  });
  groupDetailEl.querySelectorAll('.open-mail').forEach((btn) => {
    btn.addEventListener('click', () => openMailDraft(btn.dataset.groupId));
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

// ─── Actions ──────────────────────────────────────────────────────────────────

async function setFinalTime(groupId, timeId) {
  const location = document.getElementById(`location-${groupId}`)?.value?.trim() || APP.defaultLocation;
  const note = document.getElementById(`note-${groupId}`)?.value?.trim() || '';
  try {
    const { data, error } = await SB.rpc('admin_set_group_final_time', {
      p_group_id: groupId,
      p_time_option_id: timeId,
      p_location: location,
      p_note: note,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');
    await loadData();
    toast('Final time saved.', 'success');
  } catch (error) {
    console.error(error);
    toast('Could not save the final time.', 'error');
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
  const time = finalTimeForGroup(group);
  if (!time) return '';
  const location = group.final_location || APP.defaultLocation;
  return [
    'Kia ora,',
    '',
    `Your focus group session for ${group.name} has been scheduled for ${formatDateRange(time.starts_at, time.ends_at)}.`,
    '',
    `Location: ${location}`,
    group.final_note ? `Note: ${group.final_note}` : null,
    '',
    'Please add the attached calendar file to your calendar.',
  ].filter((line) => line !== null).join('\n');
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
