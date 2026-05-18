import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SB = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const $ = (s) => document.querySelector(s);

let groups      = [];
let timeOptions = [];
let finalSessions = new Map(); // group_id → [{time_option_id, location, note}]
let responses   = [];          // from admin_get_all_responses
let commsMap    = new Map();   // `${groupId}:${email}` → {status, updated_at}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  setTimeout(() => { el.className = 'toast'; }, 3300);
}

function nzDateTime(iso) {
  return new Date(iso).toLocaleString('en-NZ', {
    timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric',
    month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

function commsKey(groupId, email) {
  return `${groupId}:${(email || '').toLowerCase()}`;
}

function getStatus(groupId, email) {
  return commsMap.get(commsKey(groupId, email))?.status || 'pending';
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function loadData() {
  const [groupsR, timeR, finalR, responsesR, commsR] = await Promise.all([
    SB.from('focus_groups').select('*').order('display_order'),
    SB.from('time_options').select('*').eq('active', true).order('starts_at'),
    SB.from('group_final_sessions').select('group_id, time_option_id, location, note'),
    SB.rpc('admin_get_all_responses'),
    SB.rpc('admin_get_comms_status'),
  ]);

  if (groupsR.error)     throw groupsR.error;
  if (timeR.error)       throw timeR.error;
  if (responsesR.error)  throw responsesR.error;
  if (commsR.error)      throw commsR.error;

  groups      = groupsR.data || [];
  timeOptions = timeR.data   || [];

  finalSessions = new Map();
  for (const row of finalR.data || []) {
    if (!finalSessions.has(row.group_id)) finalSessions.set(row.group_id, []);
    finalSessions.get(row.group_id).push(row);
  }

  responses = responsesR.data || [];

  commsMap = new Map();
  for (const row of commsR.data || []) {
    commsMap.set(commsKey(row.group_id, row.user_email), row);
  }
}

async function setStatus(groupId, email, status) {
  const { error } = await SB.rpc('admin_set_comms_status', {
    p_group_id:    groupId,
    p_user_email:  email,
    p_status:      status,
  });
  if (error) throw error;
  commsMap.set(commsKey(groupId, email), { status, updated_at: new Date().toISOString() });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderPendingSummary() {
  let total = 0;
  for (const [groupId] of finalSessions) {
    const groupResps = responses.filter((r) => r.group_id === groupId);
    total += groupResps.filter((r) => getStatus(groupId, r.user_email) === 'pending').length;
  }

  const el = $('#pending-summary');
  if (!el) return;
  if (total === 0) {
    el.innerHTML = '✓ All done — everyone across your confirmed sessions has been contacted.';
    el.className = 'comms-summary comms-summary--done';
  } else {
    el.innerHTML = `⚠️ <strong>${total} ${total === 1 ? 'person' : 'people'} still need to be contacted</strong> — pending rows are highlighted below.`;
    el.className = 'comms-summary comms-summary--pending';
  }
}

function personRowHtml(groupId, r, defaultAction) {
  const status  = getStatus(groupId, r.user_email);
  const name    = escapeHtml(r.user_name || r.user_email);
  const email   = escapeHtml(r.user_email);
  const gid     = escapeHtml(groupId);
  const rawEmail = escapeHtml(r.user_email);

  const btn = (action, label, style) =>
    `<button class="comms-btn comms-btn--${style}" data-action="${action}" data-gid="${gid}" data-email="${rawEmail}">${label}</button>`;

  let statusBadge = '';
  let actions     = '';

  if (status === 'pending') {
    const primaryLabel = defaultAction === 'invited' ? '✓ Details sent' : '✓ Not-this-time sent';
    statusBadge = '<span class="comms-status comms-status--pending">Pending</span>';
    actions = btn(defaultAction, primaryLabel, 'primary') + btn('skipped', 'Skip', 'ghost');
  } else if (status === 'invited') {
    statusBadge = '<span class="comms-status comms-status--done">✉️ Details sent</span>';
    actions = btn('pending', 'Undo', 'ghost');
  } else if (status === 'not_this_time') {
    statusBadge = '<span class="comms-status comms-status--done">✉️ Not-this-time sent</span>';
    actions = btn('pending', 'Undo', 'ghost');
  } else if (status === 'skipped') {
    statusBadge = '<span class="comms-status comms-status--skipped">Skipped</span>';
    actions = btn('pending', 'Undo', 'ghost');
  }

  return `
    <div class="comms-person${status === 'pending' ? ' comms-person--pending' : ''}">
      <div class="comms-person-info">
        <span class="comms-person-name">${name}</span>
        <span class="comms-person-email">${email}</span>
      </div>
      ${statusBadge}
      <div class="comms-person-actions">${actions}</div>
    </div>`;
}

function sectionHtml(groupId, respondents, heading, defaultAction) {
  if (respondents.length === 0) return '';
  return `
    <div class="comms-section">
      <div class="comms-section-heading">${escapeHtml(heading)}</div>
      ${respondents.map((r) => personRowHtml(groupId, r, defaultAction)).join('')}
    </div>`;
}

function groupHtml(groupId) {
  const group    = groups.find((g) => g.id === groupId);
  const sessions = finalSessions.get(groupId) || [];
  const finalTimeIds = new Set(sessions.map((s) => s.time_option_id));

  const sessionLabels = sessions.map((s) => {
    const t = timeOptions.find((o) => o.id === s.time_option_id);
    return t ? nzDateTime(t.starts_at) : 'Unknown time';
  }).join('  ·  ');

  const groupResps   = responses.filter((r) => r.group_id === groupId);
  const inSession    = groupResps.filter((r) =>  r.available_time_option_ids?.some((id) => finalTimeIds.has(id)));
  const notInSession = groupResps.filter((r) => !r.available_time_option_ids?.some((id) => finalTimeIds.has(id)));

  // Sort each list: pending first, then done/skipped
  const byPending = (a, b) => {
    const pa = getStatus(groupId, a.user_email) === 'pending' ? 0 : 1;
    const pb = getStatus(groupId, b.user_email) === 'pending' ? 0 : 1;
    return pa - pb || (a.user_name || a.user_email).localeCompare(b.user_name || b.user_email);
  };
  inSession.sort(byPending);
  notInSession.sort(byPending);

  const pendingCount = groupResps.filter((r) => getStatus(groupId, r.user_email) === 'pending').length;
  const badge = pendingCount > 0
    ? `<span class="comms-pending-badge">${pendingCount} pending</span>`
    : '<span class="comms-done-badge">✓ Done</span>';

  return `
    <div class="comms-group">
      <div class="comms-group-header">
        <div>
          <h3 class="comms-group-name">${escapeHtml(group?.name || groupId)}</h3>
          <div class="comms-session-times">${escapeHtml(sessionLabels)}</div>
        </div>
        ${badge}
      </div>
      ${sectionHtml(groupId, inSession,    'In this session — send details + Teams link', 'invited')}
      ${sectionHtml(groupId, notInSession, 'Not in this session — send "not this time" email', 'not_this_time')}
    </div>`;
}

function renderAll() {
  renderPendingSummary();

  const finalisedIds = [...finalSessions.keys()];
  if (finalisedIds.length === 0) {
    $('#comms-body').innerHTML = '<p class="subtle" style="padding:4px 0">No groups have been finalised yet — come back once you\'ve confirmed a session.</p>';
    return;
  }

  $('#comms-body').innerHTML = finalisedIds.map(groupHtml).join('');

  // Wire action buttons
  $('#comms-body').querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { action, gid, email } = btn.dataset;
      btn.disabled = true;
      try {
        await setStatus(gid, email, action);
        renderAll();
      } catch (err) {
        toast('Could not update: ' + (err.message || err), 'error');
        btn.disabled = false;
      }
    });
  });
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
    renderAll();
    $('#loading').classList.add('hidden');
    $('#comms-content').classList.remove('hidden');
  } catch (err) {
    console.error(err);
    $('#loading').classList.add('hidden');
    if (err.message?.includes('forbidden') || err.code === 'P0001') {
      $('#not-admin').classList.remove('hidden');
    } else {
      const el = $('#loading');
      el.textContent = `Could not load: ${err.message || err}`;
      el.classList.remove('hidden');
    }
  }
}

main();
