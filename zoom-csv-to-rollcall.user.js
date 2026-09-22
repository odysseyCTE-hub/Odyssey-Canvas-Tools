// ==UserScript==
// @name         Zoom CSV to Roll Call (Direct Import, No Sheets)
// @namespace    odyssey-attendance-tool-zoom-direct
// @version      1.1
// @description  Upload a Zoom attendance CSV, match names against the live Canvas roster, review anything uncertain, then submit straight to Roll Call
// @match        https://rollcall.instructure.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG — tune these if matching feels too strict/loose, or if your
  // school's minute thresholds for Present/Late/Absent ever change.
  // ---------------------------------------------------------------------
  const MINUTES_PRESENT = 31; // >= this many minutes => Present (still required even if arrival was on time)
  const MINUTES_LATE = 15;    // >= this many minutes (but below Present) => Late
                               // below this => Absent

  // PRESENT requires BOTH a minutes threshold (above) AND an on-time
  // arrival (below) — the two are checked independently, and failing
  // either one caps the result at LATE instead of PRESENT. This means a
  // student who joins on time but leaves early is LATE, and a student who
  // joins late but then stays the rest of class is also LATE, not PRESENT
  // either way. Set this higher (or very large) to effectively disable the
  // arrival check and fall back to duration-only, like the original logic.
  const LATE_ARRIVAL_CUTOFF_MINUTES = 15; // joined more than this many minutes after the HOST started => not on-time

  const AUTO_MATCH_THRESHOLD = 0.72;   // score at/above this = auto-matched, no review needed
  const SUGGEST_THRESHOLD = 0.30;      // score at/above this (but below auto) = shown as a suggestion

  // The generic Zoom "Host" display name is always excluded automatically
  // (see computeStudentMinutes below). This setting is only for the case
  // where a specific teacher's own name/email shows up instead of "Host" —
  // each teacher sets their own via the "Host email/name to exclude" field
  // in the popup, saved locally per-browser via GM storage.

  // ---------------------------------------------------------------------
  // Similarity scoring — ported directly from your Apps Script
  // getSimilarityScore() function, same logic, just in browser JS.
  // ---------------------------------------------------------------------
  function getSimilarityScore(str1, str2) {
    if (!str1 || !str2) return 0.0;

    const clean1 = String(str1).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const clean2 = String(str2).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    if (clean1 === clean2) return 1.0;

    if (clean1.length >= 3 && clean2.length >= 3) {
      if (clean1.indexOf(clean2) !== -1 || clean2.indexOf(clean1) !== -1) {
        return 1.0;
      }
    }

    const words1 = clean1.split(' ');
    const words2 = clean2.split(' ');
    for (let i = 0; i < words1.length; i++) {
      for (let j = 0; j < words2.length; j++) {
        if (words1[i].length > 2 && words1[i] === words2[j]) {
          return 1.0;
        }
      }
    }

    const s1 = clean1.replace(/\s+/g, '');
    const s2 = clean2.replace(/\s+/g, '');
    if (!s1 || !s2) return 0.0;

    const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
    for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

    for (let j = 1; j <= s2.length; j += 1) {
      for (let i = 1; i <= s1.length; i += 1) {
        const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1,
          track[j - 1][i] + 1,
          track[j - 1][i - 1] + indicator
        );
      }
    }
    const distance = track[s2.length][s1.length];
    const maxLen = Math.max(s1.length, s2.length);
    return 1 - distance / maxLen;
  }

  // ---------------------------------------------------------------------
  // Splits a name into a "first" part and a "last" part (everything after
  // the first word, so compound surnames like "Reyes Castillo" stay
  // together). Used so matching can require BOTH parts to line up, instead
  // of one shared word (e.g. a shared last name) being enough on its own.
  // ---------------------------------------------------------------------
  function splitNameParts(fullName) {
    const clean = String(fullName || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ').filter(Boolean);
    if (words.length === 0) return { first: '', last: '' };
    if (words.length === 1) return { first: words[0], last: '' };
    return { first: words[0], last: words.slice(1).join(' ') };
  }

  // Combined score requiring BOTH a "first" part and a "last" part to
  // independently match reasonably well — the weaker of the two caps the
  // overall score, so a shared last name (or shared first name) alone can
  // never look like a full match. Checked in BOTH word orders, since
  // students often write "Last, First" instead of "First Last" — a fixed
  // assumption about which word is which would break exactly the cases
  // that should match.
  function combinedNameScore(zoomName, rosterFullName) {
    const z = splitNameParts(zoomName);
    const r = splitNameParts(rosterFullName);
    if (!z.first || !z.last || !r.first || !r.last) {
      // Can't verify both parts on one side or the other (e.g. only a
      // first name was given) — fall back to a whole-string comparison,
      // but cap it so a partial match can never count as "high confidence."
      return Math.min(getSimilarityScore(zoomName, rosterFullName), 0.5);
    }
    const normalOrder = Math.min(getSimilarityScore(z.first, r.first), getSimilarityScore(z.last, r.last));
    const reversedOrder = Math.min(getSimilarityScore(z.first, r.last), getSimilarityScore(z.last, r.first));
    return Math.max(normalOrder, reversedOrder);
  }

  // ---------------------------------------------------------------------
  // CSV parsing (handles quoted fields containing commas)
  // ---------------------------------------------------------------------
  function parseCsvText(text) {
    const cleanText = text.replace(/^\uFEFF/, ''); // strip BOM some Zoom exports include
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
      const c = cleanText[i];
      if (inQuotes) {
        if (c === '"') {
          if (cleanText[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 0 && r.join('').trim() !== '');
  }

  function detectColumns(headerRow) {
    let nameCol = 0, emailCol = 1, joinCol = 2, durationCol = 4, guestCol = -1, waitingRoomCol = -1;
    headerRow.forEach((h, i) => {
      const hh = String(h).trim().toLowerCase();
      if (hh.indexOf('email') !== -1) emailCol = i;
      if (hh.indexOf('duration') !== -1 || hh.indexOf('minutes') !== -1) durationCol = i;
      if (hh.indexOf('join') !== -1) joinCol = i;
      if (hh.indexOf('name') !== -1) nameCol = i;
      if (hh.indexOf('guest') !== -1) guestCol = i;
      if (hh.indexOf('waiting room') !== -1) waitingRoomCol = i;
    });
    return { nameCol, emailCol, joinCol, durationCol, guestCol, waitingRoomCol };
  }

  function parseJoinDate(rawVal) {
    if (!rawVal) return null;
    const strVal = String(rawVal).trim();
    const parsed = Date.parse(strVal);
    if (!isNaN(parsed)) return new Date(parsed);
    const datePart = strVal.split(' ')[0];
    const pieces = datePart.split('/');
    if (pieces.length === 3) {
      const m = parseInt(pieces[0], 10) - 1;
      const d = parseInt(pieces[1], 10);
      const y = parseInt(pieces[2], 10);
      if (!isNaN(m) && !isNaN(d) && !isNaN(y)) return new Date(y, m, d);
    }
    return null;
  }

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Combine multiple CSV files' rows into one dataset (first header kept, rest skipped)
  function combineCsvs(csvTexts) {
    let header = null;
    const dataRows = [];
    csvTexts.forEach((text) => {
      const parsed = parseCsvText(text);
      if (parsed.length === 0) return;
      if (!header) header = parsed[0];
      for (let r = 1; r < parsed.length; r++) dataRows.push(parsed[r]);
    });
    return { header: header || [], dataRows };
  }

  // Sum minutes per student from combined CSV rows, and also work out the
  // HOST's earliest join time — used as "when class started" for the
  // arrival-time check below. The host row itself never becomes a student
  // entry; it's Guest: No in Zoom's export, same signal already used to
  // exclude the host from the roster of attendees.
  function computeStudentMinutes(header, dataRows, excludeContains) {
    const cols = detectColumns(header);
    const students = {}; // key -> {displayName, email, minutes, everAdmitted, firstJoinTime}
    let meetingDate = null;
    let hostJoinTime = null; // earliest Join Time seen among rows marked Guest: No

    dataRows.forEach((row) => {
      const rawName = String(row[cols.nameCol] || '').trim();
      const rawEmail = String(row[cols.emailCol] || '').trim().toLowerCase();
      const rawDurationStr = String(row[cols.durationCol] || '0').replace(/[^0-9.]/g, '');
      const duration = parseFloat(rawDurationStr) || 0;
      const joinTime = parseJoinDate(row[cols.joinCol]);

      if (rawName.toLowerCase().indexOf('name') !== -1) return; // stray header row
      if (!rawName && !rawEmail) return;

      // The account holder (whoever is logged into Zoom) shows up as a
      // participant too, but marked Guest = No, while every real student
      // joining via the meeting link is Guest = Yes. This works regardless
      // of whose name/account is actually hosting. Capture their join time
      // as the meeting's effective start time before excluding them.
      if (cols.guestCol !== -1) {
        const guestVal = String(row[cols.guestCol] || '').trim().toLowerCase();
        if (guestVal === 'no') {
          if (joinTime && (!hostJoinTime || joinTime < hostJoinTime)) {
            hostJoinTime = joinTime;
          }
          return;
        }
      }

      if (
        excludeContains &&
        (rawName.toLowerCase().includes(excludeContains.toLowerCase()) ||
          rawEmail.includes(excludeContains.toLowerCase()))
      ) {
        return;
      }

      if (!meetingDate) {
        if (joinTime) meetingDate = joinTime;
      }

      const key = rawEmail || ('no-email_' + rawName.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (!students[key]) {
        students[key] = { displayName: rawName || rawEmail, email: rawEmail, minutes: 0, everAdmitted: false, firstJoinTime: null };
      }
      students[key].minutes += duration;

      // Track this student's earliest join time (first time they showed up
      // at all, even if they later left and rejoined) — this is what gets
      // compared against the host's start time for the arrival check.
      if (joinTime && (!students[key].firstJoinTime || joinTime < students[key].firstJoinTime)) {
        students[key].firstJoinTime = joinTime;
      }

      // Track whether this student ever actually made it into the real
      // meeting (not just the waiting room) at any point, even briefly —
      // used to guarantee at least "Late" instead of "Absent" further down,
      // regardless of how few minutes that entry adds up to.
      if (cols.waitingRoomCol !== -1) {
        const waitingVal = String(row[cols.waitingRoomCol] || '').trim().toLowerCase();
        if (waitingVal !== 'yes') {
          students[key].everAdmitted = true;
        }
      } else {
        // No waiting-room column to check — assume every row counts as admitted.
        students[key].everAdmitted = true;
      }
    });

    return { students, meetingDate, hostJoinTime };
  }

  // PRESENT requires BOTH: enough total minutes (mins >= MINUTES_PRESENT)
  // AND arriving within LATE_ARRIVAL_CUTOFF_MINUTES of the host's start
  // time. Either condition failing on its own caps the result at LATE —
  // a student who arrives on time but doesn't stay long enough, and a
  // student who arrives late but stays the rest of class, both land on
  // LATE, not PRESENT. arrivalDelayMinutes is null whenever we couldn't
  // determine either the host's start time or this student's join time
  // from the CSV (e.g. an export with no parseable Join Time column) — in
  // that case the arrival check is skipped and this falls back to the
  // original duration-only rule.
  function minutesToStatus(minutes, existingAttendance, everAdmitted, arrivalDelayMinutes) {
    const mins = Math.round(minutes);
    const arrivedOnTime = arrivalDelayMinutes === null || arrivalDelayMinutes <= LATE_ARRIVAL_CUTOFF_MINUTES;

    if (mins >= MINUTES_PRESENT && arrivedOnTime) return 'present';
    if (mins >= MINUTES_LATE) return 'late';
    if (mins === 0 && (existingAttendance === 'present' || existingAttendance === 'late')) {
      return existingAttendance; // don't downgrade an already-recorded status
    }
    // Made it into the real meeting at some point, even briefly — attendance
    // policy counts that as Late, never Absent, regardless of how few
    // minutes it adds up to.
    if (everAdmitted) return 'late';
    return 'absent';
  }

  // ---------------------------------------------------------------------
  // Roll Call roster fetch (same approach as the other importer)
  // ---------------------------------------------------------------------
  async function fetchRoster(classDate) {
    const sectionMatch = location.pathname.match(/sections\/(\d+)/);
    const sectionId = sectionMatch ? sectionMatch[1] : null;
    if (!sectionId) {
      throw new Error('Could not determine section_id from the page URL. Open this on a specific section\'s Roll Call page.');
    }
    const url = `https://rollcall.instructure.com/statuses?section_id=${sectionId}&class_date=${classDate}`;
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!res.ok) throw new Error(`Roster fetch failed: ${res.status}`);
    return res.json();
  }

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : null;
  }

  // Reads whatever date Roll Call's own page is currently displaying
  // (e.g. "Fri Sep 04"), so we can warn if the chosen date disagrees.
  function getVisiblePageDateText() {
    const el = document.getElementById('date');
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : null;
  }

  function getCurrentSectionName() {
    const select = document.getElementById('section_select');
    if (!select || !select.selectedOptions.length) return null;
    return select.selectedOptions[0].textContent.trim().replace(/\s+/g, ' ');
  }

  function dateInputMatchesVisiblePage(dateInputValue) {
    const visible = getVisiblePageDateText();
    if (!visible || !dateInputValue) return true;
    const [, monthNum, dayNum] = dateInputValue.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
    if (!monthNum) return true;
    const d = new Date(2000, parseInt(monthNum, 10) - 1, parseInt(dayNum, 10));
    const monthAbbr = d.toLocaleString('en-US', { month: 'short' });
    const dayStr = String(parseInt(dayNum, 10)).padStart(2, '0');
    const expected = `${monthAbbr} ${dayStr}`;
    return visible.toLowerCase().includes(expected.toLowerCase());
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  const btn = document.createElement('button');
  btn.textContent = 'Import Zoom CSV';
  Object.assign(btn.style, {
    position: 'fixed', top: '160px', right: '10px', zIndex: 99999,
    padding: '10px 14px', background: '#2E7D32', color: '#fff', border: 'none',
    borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontFamily: 'sans-serif'
  });
  document.body.appendChild(btn);

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    display: 'none', position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)',
    zIndex: 100000, alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif'
  });
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background: '#fff', borderRadius: '8px', padding: '20px', width: '720px',
    maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
  });

  modal.innerHTML = `
    <h2 style="margin-top:0;font-size:18px;">Import Zoom CSV → Roll Call</h2>
    <div id="zc-section-banner" style="background:#e7f3ff;border:1px solid #0374B5;padding:8px;border-radius:4px;font-size:13px;margin-bottom:10px;"></div>
    <p style="font-size:13px;color:#444;">
      Select one or more Zoom attendance CSV exports for this class period.
    </p>
    <div id="zc-dropzone" style="border:2px dashed #aaa;border-radius:6px;padding:20px;text-align:center;cursor:pointer;transition:background 0.15s,border-color 0.15s;">
      <p style="margin:0;font-size:13px;color:#555;">Drag CSV file(s) here, or click to browse</p>
      <input type="file" id="zc-files" accept=".csv" multiple style="display:none;" />
      <div id="zc-file-names" style="font-size:12px;color:#333;margin-top:8px;font-weight:bold;"></div>
    </div>
    <div style="margin-top:10px;">
      <label style="font-size:13px;">Your host email/name to exclude (optional, remembered for next time):</label><br/>
      <input type="text" id="zc-host-exclude" style="width:100%;padding:6px;margin-top:4px;" placeholder="e.g. your.name@school.edu" />
      <p style="font-size:11px;color:#888;margin:4px 0 0;">The meeting host is auto-detected from Zoom's "Guest" column (host = Guest: No) — this field is just a fallback for unusual exports where that doesn't apply.</p>
    </div>
    <div style="margin-top:10px;">
      <label style="font-size:13px;">Class date:</label><br/>
      <input type="date" id="zc-date" style="padding:6px;margin-top:4px;" />
      <div id="zc-date-warning" style="display:none;background:#fff3cd;border:1px solid #ffc107;padding:8px;border-radius:4px;font-size:12px;margin-top:6px;"></div>
    </div>
    <div style="margin-top:14px;text-align:right;">
      <button id="zc-cancel" style="padding:8px 14px;margin-right:8px;">Cancel</button>
      <button id="zc-analyze" style="padding:8px 14px;background:#2E7D32;color:#fff;border:none;border-radius:4px;">Analyze CSV</button>
    </div>
    <div id="zc-step2" style="display:none;margin-top:16px;">
      <h3 style="font-size:15px;">Review matches</h3>
      <p style="font-size:12px;color:#666;">
        Every entry has a dropdown, even "high confidence" ones — check any that look wrong and pick the correct student.
      </p>
      <div id="zc-match-list" style="font-size:13px;"></div>
      <div style="margin-top:14px;text-align:right;">
        <button id="zc-finalize" style="padding:8px 14px;background:#0374B5;color:#fff;border:none;border-radius:4px;">Continue to Preview</button>
      </div>
    </div>
    <div id="zc-step3" style="display:none;margin-top:16px;">
      <h3 style="font-size:15px;">Final list — review before applying</h3>
      <div id="zc-final-preview" style="font-size:13px;"></div>
      <div id="zc-noshow-section" style="margin-top:16px;"></div>
      <div style="margin-top:14px;text-align:right;">
        <button id="zc-apply" style="padding:8px 14px;background:#0374B5;color:#fff;border:none;border-radius:4px;">Apply</button>
      </div>
    </div>
    <div id="zc-status" style="margin-top:12px;font-size:13px;white-space:pre-wrap;"></div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  btn.addEventListener('click', () => {
    overlay.style.display = 'flex';
    const sectionName = getCurrentSectionName();
    modal.querySelector('#zc-section-banner').textContent = sectionName
      ? `📍 Section: ${sectionName}`
      : '⚠️ Could not detect the current section — double-check you\'re on the right page.';
    const dateInput = modal.querySelector('#zc-date');
    if (!dateInput.value) dateInput.value = toISODate(new Date());
    const hostInput = modal.querySelector('#zc-host-exclude');
    hostInput.value = GM_getValue('hostExcludeValue', '');
  });
  modal.querySelector('#zc-cancel').addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  // ---------------------------------------------------------------------
  // Drag-and-drop for the CSV file(s)
  // ---------------------------------------------------------------------
  const dropzone = modal.querySelector('#zc-dropzone');
  const fileInput = modal.querySelector('#zc-files');
  const fileNamesEl = modal.querySelector('#zc-file-names');

  function updateFileNamesDisplay() {
    fileNamesEl.textContent = fileInput.files.length
      ? Array.from(fileInput.files).map((f) => f.name).join(', ')
      : '';
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', updateFileNamesDisplay);

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.background = '#eef7ff';
    dropzone.style.borderColor = '#0374B5';
  });
  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropzone.style.background = '';
    dropzone.style.borderColor = '#aaa';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.background = '';
    dropzone.style.borderColor = '#aaa';
    const dt = new DataTransfer();
    Array.from(e.dataTransfer.files)
      .filter((f) => f.name.toLowerCase().endsWith('.csv'))
      .forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
    updateFileNamesDisplay();
  });

  // ---------------------------------------------------------------------
  // State shared across steps
  // ---------------------------------------------------------------------
  let allEntries = [];    // [{zoomEntry, status, suggestedRosterId, confidence, selectEl}]
  let rosterList = [];    // live roster fetched from Roll Call

  function claimedStudentIds(excludingIndex) {
    const claimed = new Set();
    allEntries.forEach((item, idx) => {
      if (idx === excludingIndex) return;
      if (item.selectEl && item.selectEl.value && item.selectEl.value !== 'SKIP') {
        claimed.add(item.selectEl.value);
      }
    });
    return claimed;
  }

  function renderAllDropdowns() {
    allEntries.forEach((item, idx) => {
      const select = item.selectEl;
      const currentValue = select.value;
      const claimed = claimedStudentIds(idx);
      select.innerHTML = '';
      const skipOpt = document.createElement('option');
      skipOpt.value = 'SKIP';
      skipOpt.textContent = '-- Skip this entry --';
      select.appendChild(skipOpt);

      rosterList
        .filter((r) => !claimed.has(r.student_id))
        .forEach((r) => {
          const opt = document.createElement('option');
          opt.value = r.student_id;
          opt.textContent = r.student.name;
          select.appendChild(opt);
        });

      // restore previous selection if still valid, else fall back to suggestion, else skip
      if (currentValue && (currentValue === 'SKIP' || !claimed.has(currentValue))) {
        select.value = currentValue;
      } else if (item.confidence === 'high' && item.suggestedRosterId && !claimed.has(item.suggestedRosterId)) {
        select.value = item.suggestedRosterId;
      } else {
        select.value = 'SKIP';
      }
    });
  }

  // ---------------------------------------------------------------------
  // Step 1 -> 2: Analyze
  // ---------------------------------------------------------------------
  modal.querySelector('#zc-analyze').addEventListener('click', async () => {
    const statusEl = modal.querySelector('#zc-status');
    const fileInput = modal.querySelector('#zc-files');
    const dateInput = modal.querySelector('#zc-date');

    if (!fileInput.files || fileInput.files.length === 0) {
      statusEl.textContent = 'Choose at least one CSV file first.';
      return;
    }

    statusEl.textContent = 'Reading CSV file(s)...';

    const texts = await Promise.all(
      Array.from(fileInput.files).map(
        (f) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(f);
          })
      )
    );

    const { header, dataRows } = combineCsvs(texts);
    if (dataRows.length === 0) {
      statusEl.textContent = 'No usable rows found in the uploaded CSV(s).';
      return;
    }

    const hostExclude = modal.querySelector('#zc-host-exclude').value.trim();
    GM_setValue('hostExcludeValue', hostExclude);

    const { students, meetingDate, hostJoinTime } = computeStudentMinutes(header, dataRows, hostExclude);

    const currentYear = new Date().getFullYear();
    const meetingDateIsPlausible = meetingDate && Math.abs(meetingDate.getFullYear() - currentYear) <= 1;

    const dateWarningEl = modal.querySelector('#zc-date-warning');
    if (meetingDate && !meetingDateIsPlausible) {
      // Something in the CSV's "Join time" column parsed into a bogus date
      // (a classic sign: it resolves to right around Jan 1, 1970). Don't
      // trust it — leave whatever was already in the date field alone.
      dateWarningEl.textContent = "⚠️ Couldn't reliably read a meeting date from this CSV — got something implausible. Left the date field as-is; please double-check it.";
      dateWarningEl.style.display = 'block';
    } else {
      dateWarningEl.style.display = 'none';
      if (meetingDate) dateInput.value = toISODate(meetingDate);
    }
    const classDate = dateInput.value;

    if (!hostJoinTime) {
      // Couldn't identify the host's start time at all (no Guest column,
      // or no parseable Join Time on the host's row) — the arrival-time
      // check can't run this time, so every entry falls back to the
      // original duration-only rule. Worth a visible note since it
      // silently changes how "Late" gets decided for this import.
      statusEl.textContent = "Note: couldn't determine the host's start time from this CSV — Present/Late will be based on total minutes only, not arrival time, for this import.";
    }

    statusEl.textContent += (statusEl.textContent ? ' ' : '') + 'Fetching current Canvas roster...';
    try {
      rosterList = await fetchRoster(classDate);
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      return;
    }

    // Match each zoom entry against the roster. Every entry gets a dropdown,
    // regardless of confidence — "high confidence" only affects what's
    // pre-selected, never whether it's editable.
    allEntries = [];

    Object.values(students).forEach((entry) => {
      const scored = rosterList.map((r) => {
        const sortableFlipped = (r.student.sortable_name || '').split(',').reverse().join(' ').trim();
        const scoreA = combinedNameScore(entry.displayName, r.student.name);
        const scoreB = combinedNameScore(entry.displayName, sortableFlipped);
        return { r, score: Math.max(scoreA, scoreB) };
      });
      scored.sort((a, b) => b.score - a.score);
      const bestScore = scored.length ? scored[0].score : 0;
      const bestRoster = scored.length ? scored[0].r : null;

      // Even with independent first/last scoring, an exact tie can still
      // happen (e.g. actual twins) — keep this as a last safety net.
      const tiedCount = scored.filter((s) => s.score >= bestScore - 0.001).length;
      const ambiguous = tiedCount > 1;

      // How many minutes after the host's start this student first joined —
      // null if either time couldn't be determined, which falls back to
      // the duration-only rule inside minutesToStatus.
      let arrivalDelayMinutes = null;
      if (hostJoinTime && entry.firstJoinTime) {
        arrivalDelayMinutes = Math.round((entry.firstJoinTime - hostJoinTime) / 60000);
      }

      const status = minutesToStatus(entry.minutes, bestRoster ? bestRoster.attendance : null, entry.everAdmitted, arrivalDelayMinutes);
      let confidence = 'none';
      if (bestRoster && bestScore >= AUTO_MATCH_THRESHOLD) {
        confidence = ambiguous ? 'ambiguous' : 'high';
      } else if (bestRoster && bestScore >= SUGGEST_THRESHOLD) {
        confidence = ambiguous ? 'ambiguous' : 'low';
      }

      allEntries.push({
        zoomEntry: entry,
        status,
        arrivalDelayMinutes,
        suggestedRosterId: bestRoster && confidence !== 'none' ? bestRoster.student_id : null,
        confidence,
        selectEl: null
      });
    });

    // Render the unified list
    const matchListEl = modal.querySelector('#zc-match-list');
    matchListEl.innerHTML = '';
    const confidenceLabel = { high: '✅ High confidence', low: '❓ Low confidence', ambiguous: '⚠️ Multiple matches', none: '⚠️ No suggestion' };
    const confidenceColor = { high: '#2E7D32', low: '#b8860b', ambiguous: '#d2691e', none: '#b00020' };

    allEntries.forEach((item) => {
      const row = document.createElement('div');
      row.style.marginBottom = '8px';
      let hint = '';
      if (item.confidence !== 'high' && item.suggestedRosterId) {
        const suggested = rosterList.find((r) => r.student_id === item.suggestedRosterId);
        if (suggested) hint = ` <span style="color:#888;">(possible: ${suggested.student.name})</span>`;
      }
      // Show arrival delay next to minutes whenever we have it, so it's
      // visible in the review step why something landed on Late even with
      // plenty of total minutes.
      const arrivalText = item.arrivalDelayMinutes === null
        ? ''
        : item.arrivalDelayMinutes <= 0
          ? ', arrived on time'
          : `, arrived ${item.arrivalDelayMinutes} min after host`;
      row.innerHTML = `
        <span style="display:inline-block;width:280px;">${item.zoomEntry.displayName} (${Math.round(item.zoomEntry.minutes)} min${arrivalText}, ${item.status})${hint}</span>
        <span style="display:inline-block;width:140px;color:${confidenceColor[item.confidence]};font-size:12px;">${confidenceLabel[item.confidence]}</span>
      `;
      const select = document.createElement('select');
      select.style.padding = '4px';
      row.appendChild(select);
      matchListEl.appendChild(row);
      item.selectEl = select;
      select.addEventListener('change', renderAllDropdowns);
    });
    renderAllDropdowns();

    modal.querySelector('#zc-step2').style.display = 'block';
  });

  // ---------------------------------------------------------------------
  // Step 2 -> 3: Finalize into a combined preview
  // ---------------------------------------------------------------------
  let finalList = [];

  modal.querySelector('#zc-finalize').addEventListener('click', () => {
    finalList = [];

    allEntries.forEach((item) => {
      const chosenId = item.selectEl.value;
      if (chosenId === 'SKIP') return;
      const rosterEntry = rosterList.find((r) => r.student_id === chosenId);
      if (!rosterEntry) return;
      finalList.push({
        student: rosterEntry.student,
        student_id: rosterEntry.student_id,
        section_id: rosterEntry.section_id,
        course_id: rosterEntry.course_id,
        teacher_id: rosterEntry.teacher_id,
        attendance: item.status,
        existingId: rosterEntry.id
      });
    });

    const classDate = modal.querySelector('#zc-date').value;
    const previewEl = modal.querySelector('#zc-final-preview');
    let previewHtml = '';
    if (!dateInputMatchesVisiblePage(classDate)) {
      const visible = getVisiblePageDateText();
      previewHtml += `<div style="background:#fff3cd;border:1px solid #ffc107;padding:8px;border-radius:4px;margin-bottom:10px;">
        ⚠️ <b>Date mismatch:</b> you're about to submit for <b>${classDate}</b>, but Roll Call's page is currently showing <b>${visible}</b>. Double-check this is the date you intend before applying.
      </div>`;
    }
    previewHtml += finalList.length
      ? `<b>${finalList.length} students will be updated on ${classDate} (${getCurrentSectionName() || 'unknown section'}):</b><br/>` +
        finalList.map((s) => `${s.student.name}: <b>${s.attendance}</b>`).join('<br/>')
      : '<i>Nothing to apply — everything was skipped.</i>';
    previewEl.innerHTML = previewHtml;

    // Roster students with zero corresponding Zoom entry at all — not the
    // same as "needs review" above (those had a Zoom entry, just an
    // uncertain match). This could mean a real absence, a new student,
    // or a name so garbled it never matched anything. We don't guess —
    // each one gets its own explicit choice, defaulting to no action.
    const matchedIds = new Set(finalList.map((f) => f.student_id));
    const noShowRoster = rosterList.filter((r) => !matchedIds.has(r.student_id));
    const noShowSection = modal.querySelector('#zc-noshow-section');

    if (noShowRoster.length === 0) {
      noShowSection.innerHTML = '';
    } else {
      noShowSection.innerHTML = `
        <h3 style="font-size:15px;">On roster, but no Zoom record at all (${noShowRoster.length})</h3>
        <p style="font-size:12px;color:#666;">
          Checked = will be marked Absent. Uncheck any that shouldn't be — e.g. a new student, or someone you know attended under a name that didn't match.
        </p>
        <div id="zc-noshow-list"></div>
      `;
      const listEl = noShowSection.querySelector('#zc-noshow-list');
      noShowRoster.forEach((r) => {
        const row = document.createElement('div');
        row.style.marginBottom = '4px';
        const checkboxId = `zc-noshow-${r.student_id}`;
        row.innerHTML = `
          <label style="font-size:13px;">
            <input type="checkbox" data-student-id="${r.student_id}" id="${checkboxId}" checked />
            ${r.student.name}
          </label>
        `;
        listEl.appendChild(row);
      });
    }

    modal.querySelector('#zc-step3').style.display = 'block';
  });

  // ---------------------------------------------------------------------
  // Step 3: Apply
  // ---------------------------------------------------------------------
  modal.querySelector('#zc-apply').addEventListener('click', async () => {
    const statusEl = modal.querySelector('#zc-status');
    const applyBtn = modal.querySelector('#zc-apply');
    const classDate = modal.querySelector('#zc-date').value;

    const checkedNoShowIds = Array.from(
      modal.querySelectorAll('#zc-noshow-list input[type="checkbox"]:checked')
    ).map((cb) => cb.getAttribute('data-student-id'));

    const noShowEntries = checkedNoShowIds
      .map((id) => rosterList.find((r) => r.student_id === id))
      .filter(Boolean)
      .map((r) => ({
        student: r.student,
        student_id: r.student_id,
        section_id: r.section_id,
        course_id: r.course_id,
        teacher_id: r.teacher_id,
        attendance: 'absent',
        existingId: r.id
      }));

    const submissionList = [...finalList, ...noShowEntries];

    if (submissionList.length === 0) {
      statusEl.textContent = 'Nothing to apply.';
      return;
    }

    applyBtn.disabled = true;
    const csrfToken = getCsrfToken();
    let successCount = 0;
    let failCount = 0;

    for (const entry of submissionList) {
      const payload = {
        student: entry.student,
        student_id: entry.student_id,
        section_id: entry.section_id,
        course_id: entry.course_id,
        teacher_id: entry.teacher_id,
        attendance: entry.attendance,
        class_date: classDate,
        id: entry.existingId || null,
        seated: false,
        row: null,
        col: null
      };
      try {
        const res = await fetch('https://rollcall.instructure.com/statuses', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify(payload)
        });
        if (res.ok) successCount++;
        else failCount++;
      } catch (e) {
        failCount++;
      }
      statusEl.textContent = `Applying... ${successCount + failCount}/${submissionList.length} (success: ${successCount}, failed: ${failCount})`;
      await new Promise((r) => setTimeout(r, 250));
    }

    statusEl.textContent = `Done. ${successCount} succeeded, ${failCount} failed. Reloading in a moment...`;
    setTimeout(() => location.reload(), 1500);
  });
})();
