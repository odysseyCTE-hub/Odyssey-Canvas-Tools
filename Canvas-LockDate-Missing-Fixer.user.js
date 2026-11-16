// ==UserScript==
// @name         Canvas Lock-Date Extender + Missing Tagger
// @namespace    odysseyCTE-hub
// @version      1.3.0
// @description  Re-opens Q2 work for the whole course: any assignment due on/after the Q2 start whose "Available until" is earlier than the extend date is moved to that date. Adds the Missing tag to past-due Q2 zeros that still have an attempt left. Never changes grades. Missing tags can be tested on one student first. Refreshes the gradebook when done.
// @updateURL    https://raw.githubusercontent.com/odysseyCTE-hub/Odyssey-Canvas-Tools/main/Canvas-LockDate-Missing-Fixer.user.js
// @downloadURL  https://raw.githubusercontent.com/odysseyCTE-hub/Odyssey-Canvas-Tools/main/Canvas-LockDate-Missing-Fixer.user.js
// @match        https://*.instructure.com/courses/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

/* Changelog
 * 1.3.0  Replaced the From/Through window with a simpler rule: Q2 start + Extend until. Any assignment
 *        due on/after Q2 start whose available-until is earlier than the extend date is moved to it
 *        (already locked AND locking during break). Never shortens a date. Missing tags: past-due Q2
 *        zeros with an attempt left. New Quiz "unknown attempts" choice only appears when it's needed.
 *        Late-policy notice only shows when Canvas would actually change a grade (missing grade > 0%).
 * 1.2.1  Panel can be dragged by its title bar; position is remembered. Double-click the title bar to reset.
 * 1.2.0  Date changes are now course-wide only (no individual student overrides are created).
 *        Existing section / tag / accommodation overrides in the window are moved too.
 *        "Test on one student" now limits only the Missing tags. Assignments already moved
 *        to the new date still count as in the window, so the whole-class run tags them.
 *        Added "Undo date changes". Gradebook refreshes when a run finishes; the run log
 *        is kept and shown again after the refresh.
 * 1.1.2  Added GitHub @updateURL/@downloadURL for sharing through Odyssey-Canvas-Tools.
 * 1.1.1  Moved the button and panel to the bottom-right corner.
 * 1.1.0  Default new lock = Nov 29 11:59 PM. Q2 guard. Missing tags limited to the window and to
 *        zeros with an attempt left. Grade-safety check.
 * 1.0.0  Initial version.
 */

(function () {
  'use strict';
  const VERSION = '1.3.0';

  const cm = location.pathname.match(/\/courses\/(\d+)/);
  if (!cm) return;
  const COURSE_ID = cm[1];
  const API = `/api/v1/courses/${COURSE_ID}`;
  const UNDO_KEY = `ldx_date_undo_${COURSE_ID}`;
  const LASTLOG_KEY = `ldx_last_log_${COURSE_ID}`;
  const GRADEBOOK = `/courses/${COURSE_ID}/gradebook`;

  // ---------------- API helpers ----------------
  function csrf() {
    const c = document.cookie.split('; ').find(x => x.startsWith('_csrf_token='));
    return c ? decodeURIComponent(c.slice(c.indexOf('=') + 1)) : '';
  }
  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': csrf() } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text.replace(/^while\(1\);/, '')) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`${method} ${url.replace(location.origin, '')} → ${res.status} ${String(msg).slice(0, 200)}`);
    }
    return { data, res };
  }
  async function getAll(url) {
    let out = [], next = url;
    while (next) {
      const { data, res } = await api('GET', next);
      out = out.concat(data);
      const m = (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    return out;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '(none)';
  const fmtAttempts = n => (n === Infinity ? 'unlimited' : n == null ? 'unknown' : String(n));

  const groupCache = {};
  async function groupMembers(gid) {
    if (!groupCache[gid]) {
      try {
        const users = await getAll(`/api/v1/groups/${gid}/users?per_page=100`);
        groupCache[gid] = new Set(users.map(u => u.id));
      } catch { groupCache[gid] = new Set(); }
    }
    return groupCache[gid];
  }

  // Override fields that aren't set fall back to the assignment's own value.
  const ovLock = (o, a) => ('lock_at' in o ? o.lock_at : a.lock_at);
  const ovDue = (o, a) => ('due_at' in o ? o.due_at : a.due_at);

  // Canvas PUT on an override clears any field you leave out, so always send all of them.
  function overrideBody(o, lockIso) {
    const b = { lock_at: lockIso };
    if ('due_at' in o) b.due_at = o.due_at;
    if ('unlock_at' in o) b.unlock_at = o.unlock_at;
    if (o.student_ids) b.student_ids = o.student_ids;
    return b;
  }

  // Which dates apply to one student (used only to decide Missing-tag eligibility).
  async function effectiveFor(a, stu, sub) {
    const applicable = [];
    for (const o of a.overrides || []) {
      if (o.student_ids && o.student_ids.includes(stu.id)) applicable.push(o);
      else if (o.course_section_id && stu.sections.includes(o.course_section_id)) applicable.push(o);
      else if (o.group_id && (await groupMembers(o.group_id)).has(stu.id)) applicable.push(o);
    }
    const lockVal = o => { const l = ovLock(o, a); return l ? new Date(l).getTime() : Infinity; };
    const src = applicable.length ? applicable.reduce((b, o) => (lockVal(o) > lockVal(b) ? o : b)) : null;
    return {
      lock: src ? ovLock(src, a) : a.lock_at,
      due: (sub && sub.cached_due_date) || (src ? ovDue(src, a) : a.due_at) || null,
    };
  }

  // Attempts allowed: number, Infinity (unlimited) or null (couldn't tell).
  const quizAttempts = new Map();
  const nqCache = new Map();
  async function allowedAttempts(a) {
    if (a.quiz_id && quizAttempts.has(a.quiz_id)) {
      const n = quizAttempts.get(a.quiz_id);
      return n === -1 || n == null ? Infinity : n;
    }
    if (a.is_quiz_lti_assignment) {
      if (!nqCache.has(a.id)) {
        let val = null;
        try {
          const { data } = await api('GET', `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${a.id}`);
          const ma = data && data.quiz_settings && data.quiz_settings.multiple_attempts;
          if (ma) {
            if (ma.multiple_attempts_enabled === false) val = 1;
            else if (ma.attempt_limit === false) val = Infinity;
            else if (Number(ma.max_attempts) > 0) val = Number(ma.max_attempts);
          }
        } catch { /* leave unknown */ }
        nqCache.set(a.id, val);
      }
      return nqCache.get(a.id);
    }
    const n = a.allowed_attempts;
    return n == null || n === -1 ? Infinity : n;
  }
  const ONLINE = t => (t || []).some(x => !['none', 'on_paper', 'not_graded'].includes(x));

  // ---------------- State ----------------
  const state = { students: [], plan: null, busy: false };

  // ---------------- UI ----------------
  const style = document.createElement('style');
  style.textContent = `
  #ldx-btn{position:fixed;right:16px;bottom:16px;z-index:99999;background:#1f4e79;color:#fff;border:0;border-radius:6px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.25)}
  #ldx-panel{position:fixed;right:16px;bottom:60px;z-index:99999;width:min(760px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#fff;color:#1b1b1b;border:1px solid #9aa9b8;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px/1.45 system-ui,sans-serif;display:none}
  #ldx-panel header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1f4e79;color:#fff;position:sticky;top:0;z-index:1;cursor:move;user-select:none;touch-action:none}
  #ldx-panel header b{font-size:14px}
  #ldx-panel .ldx-body{padding:12px 14px}
  #ldx-panel fieldset{border:1px solid #cfd8e1;border-radius:6px;margin:0 0 10px;padding:8px 10px}
  #ldx-panel legend{font-weight:600;padding:0 4px}
  #ldx-panel label{display:inline-flex;gap:6px;align-items:center;margin:3px 14px 3px 0}
  #ldx-panel input,#ldx-panel select{font:inherit;padding:2px 4px}
  #ldx-panel .ldx-note{color:#5a6570;font-size:12px;margin:4px 0 0}
  #ldx-panel .ldx-warn{background:#fff4d6;border:1px solid #e2b93b;border-radius:4px;padding:6px 8px;margin:6px 0}
  #ldx-panel .ldx-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  #ldx-panel button.ldx{border:1px solid #1f4e79;background:#fff;color:#1f4e79;border-radius:5px;padding:6px 12px;font:600 13px system-ui,sans-serif;cursor:pointer}
  #ldx-panel button.ldx.primary{background:#1f4e79;color:#fff}
  #ldx-panel button.ldx:disabled{opacity:.45;cursor:not-allowed}
  #ldx-panel button.ldx:focus-visible,#ldx-btn:focus-visible{outline:3px solid #f2a900;outline-offset:2px}
  #ldx-panel table{border-collapse:collapse;width:100%;margin:4px 0 10px;font-size:12px}
  #ldx-panel th,#ldx-panel td{border-bottom:1px solid #e3e8ee;padding:4px 6px;text-align:left;vertical-align:top}
  #ldx-panel th{background:#eef3f8}
  #ldx-panel tr.skip td{color:#8a949e}
  #ldx-panel details{margin:0 0 10px}
  #ldx-log{background:#f6f8fa;border:1px solid #e3e8ee;border-radius:4px;padding:6px 8px;max-height:200px;overflow:auto;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap}
  #ldx-log .err{color:#b00020}#ldx-log .ok{color:#1b7f3b}#ldx-log .warn{color:#9a6700}#ldx-log .old{opacity:.75}`;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'ldx-btn';
  btn.textContent = 'Extend dates + Missing';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'ldx-panel';
  panel.innerHTML = `
  <header title="Drag to move · double-click to reset"><b>Extend "Available until" + add Missing tags</b><span>v${VERSION}</span></header>
  <div class="ldx-body">
    <fieldset><legend>Re-open Q2 work (whole course)</legend>
      <label>Q2 starts <input type="date" id="ldx-guard" value="2026-10-21"></label>
      <label>Extend until <input type="datetime-local" id="ldx-new" value="2026-11-29T23:59"></label>
      <p class="ldx-note">Every assignment due on or after the Q2 start whose "available until" is earlier than the extend date gets moved to the extend date. That includes work that's already locked and work that would lock during break. Nothing is ever shortened, and "available from" and due dates are never changed.</p>
    </fieldset>
    <fieldset><legend>Missing tags</legend>
      <label><input type="radio" name="ldx-mode" value="test" checked> Test on one student</label>
      <label><input type="radio" name="ldx-mode" value="class"> Whole class</label><br>
      <label>Student <select id="ldx-student"><option>Loading…</option></select></label>
      <p class="ldx-note">Added to zeros on Q2 assignments that are past due, only when the student still has an attempt left. Excused and 0-point assignments are skipped. Grades are never changed.</p>
      <div id="ldx-unknownbox" style="display:none" class="ldx-warn"><label style="margin:0"><input type="checkbox" id="ldx-unknown"> <span id="ldx-unknowntext"></span></label></div>
      <div id="ldx-latepolicy"></div>
    </fieldset>
    <div class="ldx-actions">
      <button class="ldx" id="ldx-scan">Preview changes</button>
      <button class="ldx primary" id="ldx-apply" disabled>Apply changes</button>
      <button class="ldx" id="ldx-undo">Undo date changes</button>
      <button class="ldx" id="ldx-close">Close</button>
    </div>
    <div id="ldx-preview"></div>
    <div id="ldx-log"></div>
  </div>`;
  document.body.appendChild(panel);

  // ---------------- Drag the panel by its title bar ----------------
  const POS_KEY = 'ldx_panel_pos';
  const header = panel.querySelector('header');
  function placePanel(left, top) {
    const maxL = window.innerWidth - 80, maxT = window.innerHeight - 40;
    panel.style.left = Math.min(Math.max(0, left), maxL) + 'px';
    panel.style.top = Math.min(Math.max(0, top), maxT) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  const savedPos = GM_getValue(POS_KEY, null);
  if (savedPos) placePanel(savedPos.left, savedPos.top);
  header.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    header.setPointerCapture(e.pointerId);
    const move = ev => placePanel(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      const p = panel.getBoundingClientRect();
      GM_setValue(POS_KEY, { left: p.left, top: p.top });
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    e.preventDefault();
  });
  header.addEventListener('dblclick', () => {
    GM_setValue(POS_KEY, null);
    ['left', 'top', 'right', 'bottom'].forEach(k => (panel.style[k] = ''));
  });

  const $ = id => panel.querySelector('#' + id);
  const logEl = $('ldx-log');
  let runLines = null; // collects lines during a run so they survive the refresh
  function log(msg, cls = '', old = false) {
    const line = document.createElement('div');
    line.className = (cls + (old ? ' old' : '')).trim();
    line.textContent = old ? msg : `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (runLines && !old) runLines.push({ t: line.textContent, c: cls });
  }

  // Show the previous run's log after a refresh
  const last = GM_getValue(LASTLOG_KEY, null);
  if (last && last.lines && Date.now() - last.at < 10 * 60 * 1000) {
    log(`— Last run (${new Date(last.at).toLocaleTimeString()}) —`, '', true);
    last.lines.forEach(l => log(l.t, l.c, true));
    panel.style.display = 'block';
    GM_setValue(LASTLOG_KEY, null);
    init();
  }

  btn.addEventListener('click', async () => {
    const open = panel.style.display !== 'block';
    panel.style.display = open ? 'block' : 'none';
    if (open && !state.students.length) await init();
  });
  $('ldx-close').addEventListener('click', () => (panel.style.display = 'none'));
  panel.addEventListener('change', e => { if (e.target.closest('fieldset')) invalidate(); });
  function invalidate() {
    if (state.plan) { state.plan = null; $('ldx-apply').disabled = true; $('ldx-preview').innerHTML = '<p class="ldx-note">Settings changed — preview again before applying.</p>'; }
  }

  async function init() {
    if (state.students.length) return;
    try {
      log('Loading students…');
      const users = await getAll(`${API}/users?enrollment_type[]=student&enrollment_state[]=active&include[]=enrollments&per_page=100`);
      state.students = users.map(u => ({
        id: u.id,
        name: u.sortable_name || u.name,
        sections: (u.enrollments || []).filter(e => e.type === 'StudentEnrollment').map(e => e.course_section_id),
      })).sort((a, b) => a.name.localeCompare(b.name));
      $('ldx-student').innerHTML = state.students.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      log(`${state.students.length} active students loaded.`, 'ok');
    } catch (e) { log(e.message, 'err'); }
    try {
      const { data } = await api('GET', `${API}/late_policy`);
      const lp = data && data.late_policy;
      const pct = lp && lp.missing_submission_deduction_enabled ? 100 - Number(lp.missing_submission_deduction) : 0;
      if (pct > 0) {
        $('ldx-latepolicy').innerHTML = `<div class="ldx-warn">Heads up: this course is set to give missing work ${pct}%, so Canvas might raise a 0 to ${pct}% when the tag goes on. If that happens the script puts the 0 back and stops. Run your test student first.</div>`;
      }
    } catch { /* no late policy set */ }
  }

  function readSettings() {
    const mode = panel.querySelector('input[name="ldx-mode"]:checked').value;
    const nv = $('ldx-new').value, gd = $('ldx-guard').value;
    if (!nv || !gd) throw new Error('Fill in the Q2 start and the extend-until date.');
    const newDate = new Date(nv);
    const guard = new Date(gd + 'T00:00:00');
    if (newDate <= guard) throw new Error('Extend until must be after the Q2 start.');
    return { mode, uid: Number($('ldx-student').value), guard, newIso: newDate.toISOString(), newMs: newDate.getTime(), includeUnknown: $('ldx-unknown').checked };
  }

  // ---------------- Scan / preview ----------------
  $('ldx-scan').addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true; $('ldx-scan').disabled = true; $('ldx-apply').disabled = true; state.plan = null;
    try { await init(); await scan(); } catch (e) { log(e.message, 'err'); }
    state.busy = false; $('ldx-scan').disabled = false;
  });

  async function scan() {
    const s = readSettings();
    const now = Date.now();
    const inQ2 = d => !!d && new Date(d) >= s.guard;
    const needsMove = lock => !!lock && new Date(lock).getTime() < s.newMs;
    const smap = new Map(state.students.map(x => [x.id, x]));
    if (s.mode === 'test' && !smap.get(s.uid)) throw new Error('Pick a student.');

    log('Loading assignments and dates…');
    const assignments = await getAll(`${API}/assignments?include[]=overrides&per_page=100`);
    const amap = new Map(assignments.map(a => [a.id, a]));
    try {
      const quizzes = await getAll(`${API}/quizzes?per_page=100`);
      quizzes.forEach(q => quizAttempts.set(q.id, q.allowed_attempts));
    } catch { /* no classic quizzes */ }

    log('Loading submissions…');
    const subs = await getAll(`${API}/students/submissions?student_ids[]=${s.mode === 'test' ? s.uid : 'all'}&per_page=100`);

    // ---- Course-wide date changes ----
    const dates = [];
    for (const a of assignments) {
      const ovs = a.overrides || [];
      if (!a.only_visible_to_overrides && inQ2(a.due_at) && needsMove(a.lock_at))
        dates.push({ action: 'base', a, target: ovs.length ? 'Everyone else' : 'Everyone', due: a.due_at, current: a.lock_at });
      for (const o of ovs) {
        if (!('lock_at' in o)) continue; // follows the assignment's own date, which is handled above
        if (inQ2(ovDue(o, a)) && needsMove(o.lock_at))
          dates.push({ action: 'override', a, o, target: o.title || 'Override', due: ovDue(o, a), current: o.lock_at, body: overrideBody(o, s.newIso), orig: overrideBody(o, o.lock_at) });
      }
    }
    dates.sort((x, y) => new Date(x.due) - new Date(y.due));

    // ---- Missing tags: past-due Q2 zeros with an attempt left ----
    const missing = [], missingSkipped = [];
    let unknownCount = 0;
    for (const sub of subs) {
      const a = amap.get(sub.assignment_id);
      const who = smap.get(sub.user_id);
      if (!a || !who) continue;
      if (!(a.points_possible > 0) || sub.excused || sub.score !== 0) continue;
      if (sub.late_policy_status === 'missing' || sub.missing === true) continue;

      const eff = await effectiveFor(a, who, sub);
      if (!inQ2(eff.due) || new Date(eff.due).getTime() > now) continue;

      const row = { a, sub, name: who.name, due: eff.due, used: sub.attempt || 0 };
      if (!ONLINE(a.submission_types)) { missingSkipped.push({ ...row, note: 'No online submission' }); continue; }
      const allowed = await allowedAttempts(a);
      row.allowed = allowed == null ? null : allowed + (Number(sub.extra_attempts) || 0);
      if (row.allowed == null) {
        unknownCount++;
        if (s.includeUnknown) { row.note = 'New Quiz, attempt limit not reported'; missing.push(row); }
        else missingSkipped.push({ ...row, note: 'New Quiz, attempt limit not reported' });
        continue;
      }
      if (row.used >= row.allowed) { missingSkipped.push({ ...row, note: 'No attempts left' }); continue; }
      missing.push(row);
    }

    // Only ask about New Quizzes when some actually need a decision
    $('ldx-unknownbox').style.display = unknownCount ? 'block' : 'none';
    $('ldx-unknowntext').textContent = `Canvas didn't tell the script how many attempts ${unknownCount} New Quiz zero(s) allow, so it can't confirm an attempt is left. Check this box to tag them anyway, then preview again.`;

    state.plan = { s, dates, missing, missingSkipped };
    renderPreview();
    log(`Preview ready: ${dates.length} date change(s), ${missing.length} Missing tag(s). Nothing has been changed yet.`, 'ok');
    $('ldx-apply').disabled = !(dates.length || missing.length);
  }

  function renderPreview() {
    const { s, dates, missing, missingSkipped } = state.plan;
    const label = { base: 'Assignment date', override: 'Existing override' };
    const dRows = dates.map(d => `<tr><td>${esc(d.a.name)}</td><td>${esc(d.target)}</td><td>${fmt(d.due)}</td><td>${fmt(d.current)}</td><td>${fmt(s.newIso)}</td><td>${label[d.action]}</td></tr>`).join('');
    const mRow = m => `<tr><td>${esc(m.name)}</td><td>${esc(m.a.name)}</td><td>${fmt(m.due)}</td><td>0 / ${m.a.points_possible}</td><td>${m.used} of ${fmtAttempts(m.allowed)}</td><td>${esc(m.note || '')}</td></tr>`;
    const head = '<tr><th>Student</th><th>Assignment</th><th>Due</th><th>Score</th><th>Attempts used</th><th>Note</th></tr>';
    const who = s.mode === 'test' ? 'for the test student' : 'for the whole class';
    $('ldx-preview').innerHTML = `
      <h4 style="margin:6px 0 2px">Available-until changes for the whole course (${dates.length})</h4>
      ${dates.length ? `<table><tr><th>Assignment</th><th>Applies to</th><th>Due</th><th>Available until now</th><th>New</th><th>Type</th></tr>${dRows}</table>` : '<p class="ldx-note">Every Q2 assignment is already open through the extend date.</p>'}
      <h4 style="margin:6px 0 2px">Missing tags to add ${who} (${missing.length})</h4>
      ${missing.length ? `<table>${head}${missing.map(mRow).join('')}</table>` : '<p class="ldx-note">No past-due Q2 zeros qualify.</p>'}
      ${missingSkipped.length ? `<details><summary>Zeros that won't be tagged (${missingSkipped.length})</summary><table>${head}${missingSkipped.map(mRow).join('')}</table></details>` : ''}`;
  }

  // ---------------- Finish: save log and refresh gradebook ----------------
  function finishAndRefresh() {
    GM_setValue(LASTLOG_KEY, { at: Date.now(), lines: runLines || [] });
    runLines = null;
    setTimeout(() => {
      if (location.pathname.startsWith(GRADEBOOK)) location.reload();
      else location.href = GRADEBOOK;
    }, 1500);
  }

  // ---------------- Apply ----------------
  $('ldx-apply').addEventListener('click', async () => {
    const p = state.plan;
    if (!p || state.busy) return;
    const n = p.dates.length;
    const who = p.s.mode === 'class' ? 'the WHOLE CLASS' : 'the test student only';
    if (!confirm(`Change ${n} available-until date(s) for the WHOLE COURSE and add ${p.missing.length} Missing tag(s) for ${who}?\n\nThe gradebook will refresh when done.`)) return;
    state.busy = true; $('ldx-apply').disabled = true; $('ldx-scan').disabled = true;
    runLines = [];
    const undo = GM_getValue(UNDO_KEY, []);
    let ok = 0, fail = 0;

    for (const d of p.dates) {
      try {
        if (d.action === 'base') {
          await api('PUT', `${API}/assignments/${d.a.id}`, { assignment: { lock_at: p.s.newIso } });
          undo.push({ kind: 'base', aid: d.a.id, orig: d.current, name: d.a.name });
        } else {
          await api('PUT', `${API}/assignments/${d.a.id}/overrides/${d.o.id}`, { assignment_override: d.body });
          undo.push({ kind: 'override', aid: d.a.id, oid: d.o.id, orig: d.orig, name: `${d.a.name} (${d.target})` });
        }
        ok++; log(`Date updated: ${d.a.name} → ${d.target}`, 'ok');
      } catch (e) { fail++; log(`Date FAILED: ${d.a.name} — ${e.message}`, 'err'); }
      await sleep(150);
    }
    GM_setValue(UNDO_KEY, undo);

    for (const m of p.missing) {
      const url = `${API}/assignments/${m.a.id}/submissions/${m.sub.user_id}`;
      try {
        const { data } = await api('PUT', url, { submission: { late_policy_status: 'missing' } });
        if (data && data.score != null && data.score !== 0) {
          log(`Canvas changed the score to ${data.score} for ${m.name} — ${m.a.name}. Restoring 0 and STOPPING Missing tags.`, 'err');
          try {
            await api('PUT', url, { submission: { posted_grade: '0' } });
            log(`Score restored to 0 for ${m.name} — ${m.a.name}. Check that the Missing tag is still on it.`, 'warn');
          } catch (e2) { log(`Could NOT restore the 0 — fix by hand: ${m.name} — ${m.a.name} (${e2.message})`, 'err'); }
          fail++;
          break;
        }
        ok++; log(`Missing added: ${m.name} — ${m.a.name}`, 'ok');
      } catch (e) { fail++; log(`Missing FAILED: ${m.name} — ${m.a.name} — ${e.message}`, 'err'); }
      await sleep(150);
    }

    log(`Done. ${ok} succeeded, ${fail} failed or stopped. Refreshing the gradebook…`, fail ? 'warn' : 'ok');
    state.plan = null; state.busy = false;
    finishAndRefresh();
  });

  // ---------------- Undo course-wide date changes ----------------
  $('ldx-undo').addEventListener('click', async () => {
    const items = GM_getValue(UNDO_KEY, []);
    if (!items.length) { log('No date changes from this script are recorded for this course.'); return; }
    if (!confirm(`Put back the original available-until dates on ${items.length} assignment date(s) for the whole course? (Missing tags are not undone.)`)) return;
    runLines = [];
    const left = [];
    for (const it of items.slice().reverse()) {
      try {
        if (it.kind === 'base') await api('PUT', `${API}/assignments/${it.aid}`, { assignment: { lock_at: it.orig } });
        else await api('PUT', `${API}/assignments/${it.aid}/overrides/${it.oid}`, { assignment_override: it.orig });
        log(`Restored: ${it.name} → ${fmt(it.kind === 'base' ? it.orig : it.orig.lock_at)}`, 'ok');
      } catch (e) { left.unshift(it); log(`Restore FAILED: ${it.name} — ${e.message}`, 'err'); }
      await sleep(150);
    }
    GM_setValue(UNDO_KEY, left);
    log(left.length ? `${left.length} date(s) could not be restored. Refreshing the gradebook…` : 'All original dates restored. Refreshing the gradebook…', left.length ? 'warn' : 'ok');
    finishAndRefresh();
  });
})();
