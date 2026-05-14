import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SB = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const APP = {
  title: 'Dio Focus Group Scheduler',
  organisationName: 'Diocesan School for Girls',
  emailDomain: 'diocesan.school.nz',
  defaultLocation: 'To be confirmed',
  ...(window.APP_CONFIG || {}),
};

const $ = (selector) => document.querySelector(selector);

const loadingEl = $('#loading');
const signinView = $('#signin-view');
const appView = $('#app-view');
const userBar = $('#user-bar');
const groupGrid = $('#group-grid');
const timeGrid = $('#time-grid');
const form = $('#availability-form');
const saveBtn = $('#save-btn');
const clearBtn = $('#clear-btn');
const toastEl = $('#toast');
const finalCard = $('#final-card');
const savedCard = $('#saved-card');
const closedCard = $('#closed-card');

let session = null;
let groups = [];
let timeOptions = [];
let settings = {};
let myRespondent = null;
let myAvailability = new Map();
let timeSlotStats = new Map();
let groupResponseCounts = new Map();
let saveInFlight = false;

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

function appTitle() {
  return settings.app_title || APP.title;
}

function organisationName() {
  return settings.organisation_name || APP.organisationName;
}

function emailDomain() {
  return settings.email_domain || APP.emailDomain;
}

function responseCutoff() {
  const value = settings.response_cutoff_iso;
  return value ? new Date(value) : null;
}

function responsesClosed() {
  const cutoff = responseCutoff();
  return cutoff ? new Date() >= cutoff : false;
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


function selectedGroup() {
  return groups.find((group) => group.id === myRespondent?.group_id) || null;
}

function selectedFinalTime(group) {
  if (!group?.final_time_option_id) return null;
  return timeOptions.find((time) => time.id === group.final_time_option_id) || null;
}

function userDisplayName() {
  return session?.user?.user_metadata?.full_name
    || session?.user?.user_metadata?.name
    || session?.user?.email
    || '';
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

function buildPersonalIcs(group, time) {
  const location = group.final_location || APP.defaultLocation;
  const summary = `Focus group: ${group.name}`;
  const description = [
    `Group: ${group.name}`,
    group.final_note ? `Note: ${group.final_note}` : '',
    `Organised by ${organisationName()}`,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Focus Group Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${group.id}-${time.id}@focus-group-scheduler`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(time.starts_at)}`,
    `DTEND:${utcStamp(time.ends_at)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(location)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n');
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

function renderStaticText() {
  document.title = appTitle();
  $('#app-title').textContent = appTitle();
  $('#signin-copy').textContent = `Sign in with your Dio account to submit your availability.`;
  const domain = emailDomain();
  $('#domain-copy').textContent = domain ? `Only @${domain} accounts can sign in.` : '';
}

async function signIn() {
  const queryParams = {};
  if (emailDomain()) queryParams.hd = emailDomain();

  const { error } = await SB.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams,
    },
  });
  if (error) toast(error.message, 'error');
}

async function signOut() {
  await SB.auth.signOut();
  location.reload();
}

async function loadSettings() {
  const { data, error } = await SB.from('settings').select('*');
  if (error) {
    console.warn('Settings could not be loaded', error);
    return;
  }
  settings = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
  renderStaticText();
}

async function loadPublicData() {
  const [groupsR, timeR] = await Promise.all([
    SB.from('focus_groups').select('*').order('display_order'),
    SB.from('time_options').select('*').eq('active', true).order('starts_at'),
  ]);

  if (groupsR.error) throw groupsR.error;
  if (timeR.error) throw timeR.error;

  groups = groupsR.data || [];
  timeOptions = timeR.data || [];
}

async function loadGroupResponseCounts() {
  const { data, error } = await SB.from('respondents').select('group_id');
  if (error) {
    console.warn('Could not load group response counts', error);
    return;
  }
  groupResponseCounts = new Map();
  for (const row of data || []) {
    groupResponseCounts.set(row.group_id, (groupResponseCounts.get(row.group_id) || 0) + 1);
  }
}

async function loadTimeSlotStats() {
  const { data, error } = await SB.from('availability')
    .select('time_option_id, status, respondents(group_id)')
    .eq('status', 'available')
    .neq('user_id', session.user.id);

  if (error) {
    console.warn('Could not load time slot stats', error);
    return;
  }

  timeSlotStats = new Map();
  for (const row of data || []) {
    const tid = row.time_option_id;
    if (!timeSlotStats.has(tid)) timeSlotStats.set(tid, { total: 0, byGroup: new Map() });
    const entry = timeSlotStats.get(tid);
    entry.total += 1;
    const gid = row.respondents?.group_id;
    if (gid) entry.byGroup.set(gid, (entry.byGroup.get(gid) || 0) + 1);
  }
}

async function loadMyData() {
  const userId = session.user.id;
  const [respondentR, availabilityR] = await Promise.all([
    SB.from('respondents').select('*').eq('user_id', userId).maybeSingle(),
    SB.from('availability').select('time_option_id, status').eq('user_id', userId),
  ]);

  if (respondentR.error && respondentR.error.code !== 'PGRST116') throw respondentR.error;
  if (availabilityR.error) throw availabilityR.error;

  myRespondent = respondentR.data || null;
  myAvailability = new Map(
    (availabilityR.data || []).map((row) => [row.time_option_id, row.status || 'available']),
  );
}

function renderUserBar() {
  const name = userDisplayName();
  userBar.innerHTML = `
    <span>${escapeHtml(name)}</span>
    <a href="/admin">Admin</a>
    <button id="signout-btn" type="button">Sign out</button>
  `;
  $('#signout-btn').addEventListener('click', signOut);
}

function renderGroups() {
  if (groups.length === 0) {
    groupGrid.innerHTML = '<p class="empty">No groups have been configured yet.</p>';
    return;
  }

  groupGrid.innerHTML = groups.map((group) => {
    const checked = group.id === myRespondent?.group_id ? 'checked' : '';
    return `
      <label class="choice">
        <input type="radio" name="group-id" value="${escapeHtml(group.id)}" ${checked}>
        <span class="choice-inner">
          <span class="choice-title">${escapeHtml(group.name)}</span>
          ${group.description ? `<span class="choice-detail">${escapeHtml(group.description)}</span>` : ''}
        </span>
      </label>
    `;
  }).join('');

  groupGrid.querySelectorAll('label.choice').forEach((label) => {
    const input = label.querySelector('input[type="radio"]');
    label.addEventListener('mousedown', () => {
      label.dataset.wasChecked = input.checked ? 'true' : '';
    });
    label.addEventListener('click', () => {
      if (label.dataset.wasChecked === 'true') {
        input.checked = false;
      }
      renderTimeOptions();
    });
  });
}

function renderTimeOptions() {
  if (timeOptions.length === 0) {
    timeGrid.innerHTML = '<p class="empty">No time options have been configured yet.</p>';
    $('#time-count').textContent = '';
    return;
  }

  const byDay = new Map();
  for (const time of timeOptions) {
    const dayKey = new Date(time.starts_at).toLocaleDateString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(time);
  }

  const cutoff = new Date(Date.now() + 30 * 60 * 1000);
  const currentGroupId = form.querySelector('input[name="group-id"]:checked')?.value || null;

  timeGrid.innerHTML = Array.from(byDay.entries()).map(([day, times]) => `
    <div class="day-section">
      <h3 class="day-heading">${escapeHtml(day)}</h3>
      <div class="day-slots">
        ${times.map((time) => {
          const isPast = new Date(time.starts_at) <= cutoff;
          const status = myAvailability.get(time.id) || 'unavailable';
          const startTime = new Date(time.starts_at).toLocaleTimeString('en-NZ', {
            hour: 'numeric', minute: '2-digit', hour12: true,
          });
          const stats = timeSlotStats.get(time.id);
          const inGroupCount = currentGroupId ? (stats?.byGroup?.get(currentGroupId) || 0) : 0;
          const hasGroupInterest = inGroupCount > 0;

          let statsHtml = '';
          if (stats && stats.total > 0) {
            const people = (n) => n === 1 ? '1 other person' : `${n} other people`;
            const groupPart = currentGroupId && inGroupCount > 0
              ? `<span class="slot-stat-group">${people(inGroupCount)} from your group</span>`
              : '';
            statsHtml = `<div class="slot-stats">
              <span class="slot-stat-total">${people(stats.total)} also available</span>
              ${groupPart}
            </div>`;
          }

          return `
            <div class="time-choice${hasGroupInterest ? ' time-choice--group-interest' : ''}${isPast ? ' time-choice--past' : ''}">
              <div class="time-inner">
                <div class="time-left">
                  <span class="time-title">${escapeHtml(startTime)}</span>
                  ${statsHtml}
                </div>
                <div class="availability-toggle" role="radiogroup" aria-label="${escapeHtml(time.label)}">
                  <label>
                    <input type="radio" name="availability-${escapeHtml(time.id)}" value="available" ${status === 'available' ? 'checked' : ''} ${isPast ? 'disabled' : ''}>
                    <span>Available</span>
                  </label>
                  <label>
                    <input type="radio" name="availability-${escapeHtml(time.id)}" value="unavailable" ${status === 'unavailable' ? 'checked' : ''} ${isPast ? 'disabled' : ''}>
                    <span>Unavailable</span>
                  </label>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  updateSelectedTimeCount();
}

function renderStatusCards() {
  const group = selectedGroup();
  const finalTime = selectedFinalTime(group);

  finalCard.classList.add('hidden');
  savedCard.classList.add('hidden');
  closedCard.classList.add('hidden');

  if (responsesClosed()) {
    closedCard.classList.remove('hidden');
    closedCard.innerHTML = `
      <h2>Availability collection is closed</h2>
      <div>Saved responses are still visible here.</div>
    `;
  }

  if (myRespondent) {
    savedCard.classList.remove('hidden');
    const counts = availabilityCountsFromMap(myAvailability);
    savedCard.innerHTML = `
      <h2>Saved</h2>
      <div>${escapeHtml(group?.name || 'Group not found')} · ${counts.available} available.</div>
      <div class="meta-line">Updated ${new Date(myRespondent.updated_at).toLocaleString('en-NZ')}</div>
    `;
  }

  if (group && finalTime) {
    const location = group.final_location || APP.defaultLocation;
    finalCard.classList.remove('hidden');
    finalCard.innerHTML = `
      <h2>Your focus group has been scheduled</h2>
      <div><strong>${escapeHtml(group.name)}</strong></div>
      <div>${escapeHtml(formatDateRange(finalTime.starts_at, finalTime.ends_at))}</div>
      <div>${escapeHtml(location)}</div>
      ${group.final_note ? `<div class="meta-line">${escapeHtml(group.final_note)}</div>` : ''}
      <div class="actions">
        <button id="download-final-ics" class="secondary" type="button">Download calendar file</button>
      </div>
    `;
    $('#download-final-ics').addEventListener('click', () => {
      const ics = buildPersonalIcs(group, finalTime);
      downloadText(`focus-group-${group.id}.ics`, ics, 'text/calendar;charset=utf-8');
      toast('Calendar file downloaded.', 'success');
    });
  }

  const finalTime = selectedFinalTime(group);
  $('#status-copy').innerHTML = finalTime
    ? 'Your session has been confirmed — your availability is now locked. We\'ll be in touch with details by email.'
    : myRespondent
      ? 'You can update your availability for sessions that haven\'t started yet.'
      : 'Choose your group, then mark each time as available or unavailable.';

}

function renderFormState() {
  const finalised = !!selectedFinalTime(selectedGroup());
  const disabled = responsesClosed() || saveInFlight || finalised;
  form.querySelectorAll('input').forEach((input) => {
    if (input.closest('.time-choice--past')) return;
    input.disabled = disabled;
  });
  saveBtn.disabled = disabled;
  clearBtn.disabled = disabled;
}

function renderGroupCounts() {
  const el = $('#group-counts');
  if (!el) return;
  if (groupResponseCounts.size === 0) { el.innerHTML = ''; return; }

  const total = [...groupResponseCounts.values()].reduce((a, b) => a + b, 0);
  const rows = groups
    .filter((g) => groupResponseCounts.has(g.id))
    .map((g) => `
      <div class="group-count-row">
        <span class="group-count-name">${escapeHtml(g.name)}</span>
        <span class="group-count-badge">${groupResponseCounts.get(g.id)}</span>
      </div>
    `).join('');

  el.innerHTML = `
    <p class="group-counts-heading">${total} response${total !== 1 ? 's' : ''} so far</p>
    <div class="group-counts">${rows}</div>
  `;
}

function render() {
  renderStaticText();
  renderUserBar();
  renderGroups();
  renderTimeOptions();
  renderStatusCards();
  renderGroupCounts();
  renderFormState();
}

function selectedAvailabilityFromForm() {
  return timeOptions
    .map((time) => {
      const status = form.querySelector(`input[name="availability-${time.id}"]:checked`)?.value || 'unavailable';
      return { time_option_id: time.id, status };
    })
    .filter((item) => item.status !== 'unavailable');
}

function updateSelectedTimeCount() {
  const count = selectedAvailabilityFromForm().filter((i) => i.status === 'available').length;
  $('#time-count').textContent = count > 0 ? `${count} available` : 'All marked unavailable';
}

function availabilityCountsFromMap(availabilityMap) {
  const available = [...availabilityMap.values()].filter((s) => s === 'available').length;
  return { available };
}

async function saveAvailability(event) {
  event.preventDefault();
  if (saveInFlight || responsesClosed()) return;

  const groupId = form.querySelector('input[name="group-id"]:checked')?.value;
  if (!groupId) {
    toast('Choose your group first.', 'error');
    return;
  }

  const availability = selectedAvailabilityFromForm();
  saveInFlight = true;
  renderFormState();

  try {
    const { data, error } = await SB.rpc('save_my_availability', {
      p_group_id: groupId,
      p_availability: availability,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'save_failed');

    await Promise.all([loadMyData(), loadTimeSlotStats(), loadGroupResponseCounts()]);
    render();
    toast('Availability saved.', 'success');
  } catch (error) {
    console.error(error);
    const code = error.message || String(error);
    const message = {
      editing_closed: 'Responses are closed.',
      wrong_domain: `Only @${emailDomain()} accounts can respond.`,
      invalid_group: 'That group is not available.',
      invalid_time_option: 'One of those time options is no longer available.',
      invalid_availability: 'One of those availability responses is not valid.',
      duplicate_time_option: 'A time option was submitted more than once.',
      email_not_verified: 'Your email address needs to be verified.',
      not_authenticated: 'Please sign in again.',
    }[code] || 'Could not save. Try again.';
    toast(message, 'error');
  } finally {
    saveInFlight = false;
    renderFormState();
  }
}

function clearTimes() {
  timeOptions.forEach((time) => {
    const input = form.querySelector(`input[name="availability-${time.id}"][value="unavailable"]`);
    if (input && !input.closest('.time-choice--past')) input.checked = true;
  });
  updateSelectedTimeCount();
}

async function main() {
  renderStaticText();
  $('#google-signin').addEventListener('click', signIn);
  form.addEventListener('submit', saveAvailability);
  form.addEventListener('change', (event) => {
    if (event.target?.name?.startsWith('availability-')) updateSelectedTimeCount();
  });
  clearBtn.addEventListener('click', clearTimes);

  if (window.location.hash.includes('access_token') || window.location.hash.includes('error')) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  session = (await SB.auth.getSession()).data.session;
  if (!session) {
    loadingEl.classList.add('hidden');
    signinView.classList.remove('hidden');
    return;
  }

  try {
    await loadSettings();
    const domain = emailDomain();
    const email = session.user?.email || '';
    if (domain && !email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) {
      toast(`Only @${domain} accounts can respond.`, 'error');
      await SB.auth.signOut();
      setTimeout(() => location.reload(), 1200);
      return;
    }

    await Promise.all([loadPublicData(), loadMyData()]);
    await Promise.all([loadTimeSlotStats(), loadGroupResponseCounts()]);
    loadingEl.classList.add('hidden');
    appView.classList.remove('hidden');
    render();
  } catch (error) {
    console.error(error);
    loadingEl.innerHTML = `<p style="color:var(--red)">Could not load the scheduler: ${escapeHtml(error.message || error)}</p>`;
  }
}

SB.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') location.reload();
});

main();
