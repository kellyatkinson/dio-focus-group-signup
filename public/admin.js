import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SB = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const APP = {
  title: 'Focus Group Scheduler',
  organisationName: 'Your organisation',
  defaultLocation: 'To be confirmed',
  ...(window.APP_CONFIG || {}),
};

const $ = (selector) => document.querySelector(selector);

const loadingEl = $('#loading');
const notAdminEl = $('#not-admin');
const contentEl = $('#admin-content');
const groupResultsEl = $('#group-results');
const respondentTableEl = $('#respondent-table');
const summaryEl = $('#summary');
const toastEl = $('#toast');

let session = null;
let summaryRows = [];
let responses = [];
let searchTerm = '';

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
  setTimeout(() => {
    toastEl.className = 'toast';
  }, 3300);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function utcStamp(dateValue) {
  const date = new Date(dateValue);
  return date.getUTCFullYear()
    + pad(date.getUTCMonth() + 1)
    + pad(date.getUTCDate())
    + 'T'
    + pad(date.getUTCHours())
    + pad(date.getUTCMinutes())
    + pad(date.getUTCSeconds())
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
  const sameDay = start.toDateString() === end.toDateString();
  const datePart = start.toLocaleDateString('en-NZ', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const startTime = start.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `${datePart}, ${startTime} - ${endTime}`;
  const endPart = end.toLocaleDateString('en-NZ', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart}, ${startTime} - ${endPart}`;
}

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
      if_needed_count: row.if_needed_count,
      unavailable_count: row.unavailable_count,
    });
  }
  return [...byGroup.values()];
}

function responsesForGroup(groupId) {
  return responses
    .filter((row) => row.group_id === groupId)
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));
}

function sortName(row) {
  const name = (row.user_name || '').trim().toLowerCase();
  const email = (row.user_email || '').toLowerCase();
  return name ? `${name}|${email}` : email;
}

function finalTimeForGroup(group) {
  return group.times.find((time) => time.id === group.final_time_option_id) || null;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderSummary() {
  const groups = groupModels();
  const respondentCount = responses.length;
  const finalisedCount = groups.filter((group) => group.final_time_option_id).length;
  const totalAvailable = responses.reduce((total, row) => total + (row.available_time_option_ids?.length || 0), 0);
  const totalIfNeeded = responses.reduce((total, row) => total + (row.if_needed_time_option_ids?.length || 0), 0);

  summaryEl.innerHTML = `
    <div class="stat"><span class="stat-label">Respondents</span><span class="stat-value">${respondentCount}</span></div>
    <div class="stat"><span class="stat-label">Groups</span><span class="stat-value">${groups.length}</span></div>
    <div class="stat"><span class="stat-label">Yes / if needed</span><span class="stat-value">${totalAvailable} / ${totalIfNeeded}</span></div>
    <div class="stat"><span class="stat-label">Scheduled groups</span><span class="stat-value">${finalisedCount}</span></div>
  `;
}

function renderGroups() {
  const q = searchTerm.toLowerCase();
  const groups = groupModels().filter((group) => {
    if (!q) return true;
    return group.name.toLowerCase().includes(q)
      || responsesForGroup(group.id).some((row) => (
        (row.user_email || '').toLowerCase().includes(q)
        || (row.user_name || '').toLowerCase().includes(q)
      ));
  });

  if (groups.length === 0) {
    groupResultsEl.innerHTML = '<p class="empty">No groups match.</p>';
    return;
  }

  groupResultsEl.innerHTML = groups.map((group) => renderGroup(group)).join('');
  wireGroupActions(groups);
}

function renderGroup(group) {
  const total = Number(group.total || 0);
  const best = group.times.reduce((current, time) => {
    const available = Number(time.available_count || 0);
    const ifNeeded = Number(time.if_needed_count || 0);
    if (available > current.available) return { available, ifNeeded };
    if (available === current.available && ifNeeded > current.ifNeeded) return { available, ifNeeded };
    return current;
  }, { available: 0, ifNeeded: 0 });
  const finalTime = finalTimeForGroup(group);
  const recipients = responsesForGroup(group.id);
  const location = group.final_location || APP.defaultLocation;

  const timeCards = group.times.map((time) => {
    const available = Number(time.available_count || 0);
    const ifNeeded = Number(time.if_needed_count || 0);
    const unavailable = Number(time.unavailable_count || 0);
    const availablePercent = total ? Math.round((available / total) * 100) : 0;
    const ifNeededPercent = total ? Math.round((ifNeeded / total) * 100) : 0;
    const isBest = available === best.available && ifNeeded === best.ifNeeded && (available + ifNeeded > 0);
    const isFinal = time.id === group.final_time_option_id;
    const classes = ['result-card', isBest ? 'best' : '', isFinal ? 'final' : ''].filter(Boolean).join(' ');
    return `
      <div class="${classes}">
        <div>
          <div class="result-title">${escapeHtml(time.label)}</div>
          <div class="meta-line">${escapeHtml(formatDateRange(time.starts_at, time.ends_at))}</div>
        </div>
        <div class="meter" aria-hidden="true">
          <span class="available" style="--value:${availablePercent}%"></span>
          <span class="if-needed" style="--value:${ifNeededPercent}%"></span>
        </div>
        <div class="toolbar">
          <span class="badge good">${available} yes</span>
          <span class="badge warn">${ifNeeded} if needed</span>
          <span class="badge neutral">${unavailable} no</span>
          ${isBest ? '<span class="badge good">Best</span>' : ''}
          ${isFinal ? '<span class="badge neutral">Final</span>' : ''}
        </div>
        <button class="secondary set-final" type="button" data-group-id="${escapeHtml(group.id)}" data-time-id="${escapeHtml(time.id)}">
          ${isFinal ? 'Update final details' : 'Set as final'}
        </button>
      </div>
    `;
  }).join('');

  const finalBlock = finalTime ? `
    <div class="notification-tools">
      <div><strong>Final:</strong> ${escapeHtml(formatDateRange(finalTime.starts_at, finalTime.ends_at))}</div>
      <div class="meta-line">${escapeHtml(location)}${group.final_note ? ` - ${escapeHtml(group.final_note)}` : ''}</div>
      <div class="actions">
        <button class="secondary copy-emails" type="button" data-group-id="${escapeHtml(group.id)}">Copy emails</button>
        <button class="secondary copy-message" type="button" data-group-id="${escapeHtml(group.id)}">Copy message</button>
        <button class="secondary download-ics" type="button" data-group-id="${escapeHtml(group.id)}">Download .ics</button>
        <button class="secondary download-recipients" type="button" data-group-id="${escapeHtml(group.id)}">Download recipient CSV</button>
        <button class="ghost open-mail" type="button" data-group-id="${escapeHtml(group.id)}">Open email draft</button>
      </div>
    </div>
  ` : '';

  return `
    <article class="group-admin">
      <div class="group-admin-head">
        <div>
          <h2>${escapeHtml(group.name)}</h2>
          ${group.description ? `<div class="meta-line">${escapeHtml(group.description)}</div>` : ''}
        </div>
        <span class="badge neutral">${recipients.length} respondent${recipients.length === 1 ? '' : 's'}</span>
      </div>
      <div class="time-results">${timeCards}</div>
      <div class="final-form">
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
    </article>
  `;
}

function renderRespondents() {
  const q = searchTerm.toLowerCase();
  const rows = responses
    .filter((row) => !q
      || (row.user_name || '').toLowerCase().includes(q)
      || (row.user_email || '').toLowerCase().includes(q)
      || (row.group_name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.group_name || '').localeCompare(b.group_name || '') || sortName(a).localeCompare(sortName(b)));

  if (rows.length === 0) {
    respondentTableEl.innerHTML = '<p class="empty">No respondents match.</p>';
    return;
  }

  respondentTableEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Group</th>
          <th>Available</th>
          <th>If needed</th>
          <th>Unavailable</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.user_name || '')}</td>
            <td>${escapeHtml(row.user_email)}</td>
            <td>${escapeHtml(row.group_name)}</td>
            <td>${escapeHtml((row.available_labels || []).join('; '))}</td>
            <td>${escapeHtml((row.if_needed_labels || []).join('; '))}</td>
            <td>${escapeHtml((row.unavailable_labels || []).join('; '))}</td>
            <td>${new Date(row.updated_at).toLocaleString('en-NZ')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function render() {
  renderSummary();
  renderGroups();
  renderRespondents();
}

function wireGroupActions(groups) {
  groupResultsEl.querySelectorAll('.set-final').forEach((button) => {
    button.addEventListener('click', () => setFinalTime(button.dataset.groupId, button.dataset.timeId));
  });
  groupResultsEl.querySelectorAll('.copy-emails').forEach((button) => {
    button.addEventListener('click', () => copyGroupEmails(button.dataset.groupId));
  });
  groupResultsEl.querySelectorAll('.copy-message').forEach((button) => {
    button.addEventListener('click', () => copyGroupMessage(button.dataset.groupId));
  });
  groupResultsEl.querySelectorAll('.download-ics').forEach((button) => {
    button.addEventListener('click', () => downloadGroupIcs(button.dataset.groupId));
  });
  groupResultsEl.querySelectorAll('.download-recipients').forEach((button) => {
    button.addEventListener('click', () => downloadRecipients(button.dataset.groupId));
  });
  groupResultsEl.querySelectorAll('.open-mail').forEach((button) => {
    button.addEventListener('click', () => openMailDraft(button.dataset.groupId));
  });

  for (const group of groups) {
    const locationEl = document.getElementById(`location-${group.id}`);
    if (locationEl && !locationEl.value) locationEl.value = APP.defaultLocation;
  }
}

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

function groupById(groupId) {
  return groupModels().find((group) => group.id === groupId) || null;
}

function buildMessage(group) {
  const time = finalTimeForGroup(group);
  if (!time) return '';
  const location = group.final_location || APP.defaultLocation;
  return [
    `Kia ora,`,
    '',
    `Your focus group session for ${group.name} has been scheduled for ${formatDateRange(time.starts_at, time.ends_at)}.`,
    '',
    `Location: ${location}`,
    group.final_note ? `Note: ${group.final_note}` : null,
    '',
    'Please add the attached calendar file to your calendar.',
  ].filter((line) => line !== null).join('\n');
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
    'PRODID:-//Focus Group Scheduler//EN',
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
    ...recipients.map((row) => (
      `ATTENDEE;CN=${icsEscape(row.user_name || row.user_email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${row.user_email}`
    )),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n');
}

function downloadGroupIcs(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const ics = buildGroupIcs(group);
  if (!ics) {
    toast('Set a final time first.', 'error');
    return;
  }
  downloadText(`focus-group-${group.id}.ics`, ics, 'text/calendar;charset=utf-8');
  toast('Calendar file downloaded.', 'success');
}

function downloadRecipients(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const headers = ['Name', 'Email', 'Group', 'Available', 'If needed', 'Unavailable'];
  const rows = responsesForGroup(groupId).map((row) => [
    row.user_name,
    row.user_email,
    row.group_name,
    (row.available_labels || []).join('; '),
    (row.if_needed_labels || []).join('; '),
    (row.unavailable_labels || []).join('; '),
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadText(`focus-group-${group.id}-recipients.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
}

function openMailDraft(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const recipients = responsesForGroup(groupId)
    .map((row) => encodeURIComponent(row.user_email))
    .join(',');
  const subject = `Focus group session: ${group.name}`;
  const body = `${buildMessage(group)}\n\nCalendar file: download the .ics from the admin page and attach it before sending.`;
  const url = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

function exportResponsesCsv() {
  const headers = ['Name', 'Email', 'Group', 'Available', 'If needed', 'Unavailable', 'Updated'];
  const rows = responses
    .sort((a, b) => (a.group_name || '').localeCompare(b.group_name || '') || sortName(a).localeCompare(sortName(b)))
    .map((row) => [
      row.user_name,
      row.user_email,
      row.group_name,
      (row.available_labels || []).join('; '),
      (row.if_needed_labels || []).join('; '),
      (row.unavailable_labels || []).join('; '),
      row.updated_at,
    ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadText(`focus-group-responses-${stamp}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
}

async function loadData() {
  const [summaryR, responsesR] = await Promise.all([
    SB.rpc('admin_get_availability_summary'),
    SB.rpc('admin_get_all_responses'),
  ]);

  if (summaryR.error) throw summaryR.error;
  if (responsesR.error) throw responsesR.error;

  summaryRows = summaryR.data || [];
  responses = responsesR.data || [];
  render();
}

async function signOut() {
  await SB.auth.signOut();
  location.href = '/';
}

async function main() {
  session = (await SB.auth.getSession()).data.session;
  if (!session) {
    location.href = '/';
    return;
  }

  $('#admin-email').textContent = session.user.email;
  $('#signout-btn').addEventListener('click', signOut);
  $('#refresh-btn').addEventListener('click', async () => {
    await loadData();
    toast('Data refreshed.', 'success');
  });
  $('#export-responses-btn').addEventListener('click', exportResponsesCsv);
  $('#search').addEventListener('input', (event) => {
    searchTerm = event.target.value.trim();
    render();
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
