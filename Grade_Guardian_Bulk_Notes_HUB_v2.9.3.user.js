// ==UserScript==
// @name         Grade Guardian Bulk Notes-HUB
// @namespace    lisa-attendance-tool-gg-notes
// @version      2.9.3
// @description  Bulk notes + pending-note bridge + direct Grade Guardian communication sync to Student Monitoring Hub.
// @match        https://prd-m.aspiredu.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------
  // Read the page's own embedded roster context (section, filters, total
  // count) so we don't have to guess or hardcode any of it.
  // ---------------------------------------------------------------------
  function getListContext() {
    const el = document.getElementById('student-list-context');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  function parseRosterRowsFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [];
    doc.querySelectorAll('tr[id^="studentRow-"]').forEach((row) => {
      const lmsId = row.getAttribute('data-user-lms-id');
      const userId = row.getAttribute('data-user-id');
      const nameEl = row.querySelector('.user-name .fw-bold');
      const name = nameEl ? nameEl.textContent.trim() : null;
      if (lmsId && userId && name) {
        rows.push({ lmsId, userId, name });
      }
    });
    return rows;
  }

  // ---------------------------------------------------------------------
  // Read the live tag list (name -> UUID) directly from the page, so it
  // stays correct even if tags are added/renamed later.
  // ---------------------------------------------------------------------
  // Treats the first word as a first name and everything after it as the
  // last name (handles compound surnames like "Reyes Castillo" as one unit),
  // so the roster list can be sorted by last name instead of first.
  function lastNameSortKey(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/);
    if (parts.length <= 1) return fullName || '';
    return parts.slice(1).join(' ') + ', ' + parts[0];
  }

  // Captured directly from the real tag dropdown earlier. This is the
  // fallback used here, since the live <select id="id_tags"> element only
  // exists on a student's individual Notes page — not on the roster page
  // this panel actually runs on. If tags are ever added/renamed/removed on
  // Grade Guardian's side, this list needs a manual update to match.
  const FALLBACK_TAGS = [
    { uuid: 'ac6e7e12-ead3-4a97-a783-0fe1797ad734', label: 'Administrative Referral_HS' },
    { uuid: 'b547ef94-e222-44ae-a663-f1b924b9a70b', label: 'Administrative Referral_MS' },
    { uuid: 'ea29b464-a671-4e16-9503-c4c7b89af0df', label: 'Attendance Notes & Excuses' },
    { uuid: 'e8a24169-53d9-4d5d-a2a5-d618853fb785', label: 'Email' },
    { uuid: '7f1c2ae6-d11d-4f2f-9bd1-dc924537676a', label: 'Physical Mail' },
    { uuid: '86567e25-ec64-45aa-a890-cb6bb74e37f9', label: 'Staff to Staff' },
    { uuid: 'c24206f9-4098-427c-8470-42ff4973d13c', label: 'Successful Guardian Phone SGP' },
    { uuid: 'c6faab3f-97cc-45b9-8437-729db4634d9d', label: 'Successful Guardian Zoom SGZ' },
    { uuid: 'cfeeff47-9884-4478-92c8-fbd75993b546', label: 'Successful Student Phone SSP' },
    { uuid: '4fb4852a-ac92-4a90-8215-0864e7852932', label: 'Successful Student Zoom SSZ' },
    { uuid: '07f14873-7461-42b2-ba7c-148e9e33c1ef', label: 'Successful Student/Guardian Phone SSGP' },
    { uuid: 'd63c3a01-d8c2-4b3c-8a1e-3e299c38238a', label: 'Successful Student/Guardian Zoom SSGZ' },
    { uuid: '90221b9c-f0d0-4cfa-8d53-2777c3afede4', label: 'Text Message' },
    { uuid: '233935fd-8a61-4c5c-91f4-b19100414034', label: 'Unsuccessful Guardian Phone UGP' },
    { uuid: 'fb37e9ca-e5e7-4639-9fcc-252f193f5d6c', label: 'Unsuccessful Guardian Zoom UGZ' },
    { uuid: '33db6ac3-af36-459a-9e62-3c4455a4923e', label: 'Unsuccessful Student Phone USP' },
    { uuid: '9fa0f61d-fc4d-479d-b45f-e2e1a0137278', label: 'Unsuccessful Student Zoom USZ' },
    { uuid: '4ddca660-279e-49fb-8e39-9b31eb5a1734', label: 'Unsuccessful Student/Guardian Phone USGP' },
    { uuid: '859e4bbb-fae3-4a7e-b467-46fd0d4ca9f5', label: 'Unsuccessful Student/Guardian Zoom USGZ' },
    { uuid: 'd9ec1e27-2206-4aef-9073-2365454452c0', label: 'Updated Contact Information' },
    { uuid: '1a7ffb9f-dd15-432f-abea-5455e64ee104', label: 'Well Check' }
  ];

  function getTagOptions() {
    const select = document.getElementById('id_tags');
    if (select) {
      const live = Array.from(select.querySelectorAll('option')).map((opt) => ({
        uuid: opt.value,
        label: opt.textContent.trim()
      }));
      if (live.length > 0) return live;
    }
    return FALLBACK_TAGS;
  }

  // ---------------------------------------------------------------------
  // Submit one note to one student, directly via the API endpoint.
  // ---------------------------------------------------------------------
  function getFormFieldValue(name) {
    const el = document.querySelector(`input[name="${name}"]`);
    return el ? el.value : null;
  }

  async function submitNote(student, noteText, tagUuid) {
    const csrfCookie = getCookie('csrftoken');
    const ltiToken = getFormFieldValue('ltimiddlewaretoken');
    const payload = {
      acknowledge_alerts: [],
      alert: null,
      note: noteText,
      set_alert: null,
      tag_uuids: tagUuid ? [tagUuid] : [],
      user: student.userId
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfCookie,
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (ltiToken) headers['Authorization'] = `Bearer ${ltiToken}`;

    const res = await fetch(`https://prd-m.aspiredu.com/detective/api/user/${student.lmsId}/note/`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  const btn = document.createElement('button');
  btn.textContent = 'Bulk Add Note';
  Object.assign(btn.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: 99999,
    padding: '10px 14px', background: '#29847E', color: '#fff', border: 'none',
    borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontFamily: 'sans-serif'
  });
  document.body.appendChild(btn);

  // A docked side panel, not a full-screen overlay — the real page (and its
  // pagination buttons) needs to stay clickable while this is open, since
  // the workflow is "page on the real site, then tell this panel to notice."
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    display: 'none', position: 'fixed', top: '145px', right: '10px', zIndex: 99998,
    background: '#fff', borderRadius: '8px', padding: '16px', width: '360px',
    maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
    border: '1px solid #ddd', fontFamily: 'sans-serif'
  });

  modal.innerHTML = `
    <h2 id="ggn-drag-handle" style="margin-top:0;font-size:16px;cursor:move;user-select:none;padding:4px;margin:-4px -4px 8px -4px;border-radius:4px;" title="Drag to move">⠿ Bulk Add Note</h2>
    <div id="ggn-status" style="font-size:12px;color:#444;margin-bottom:8px;">Just page through the real site behind this panel — new students get added automatically.</div>

    <div style="margin-bottom:12px;">
      <button type="button" id="ggn-sync-communication-hub" style="width:100%;padding:8px 12px;background:#4d5ea1;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:700;cursor:pointer;">
        Sync GG Communication → Hub
      </button>
    </div>

    <div style="margin-bottom:8px;">
      <button id="ggn-select-all" style="padding:4px 10px;font-size:12px;margin-right:6px;">Select All</button>
      <button id="ggn-select-none" style="padding:4px 10px;font-size:12px;margin-right:6px;">Select None</button>
      <span id="ggn-selected-count" style="font-size:12px;color:#555;">0 selected</span>
    </div>
    <div id="ggn-roster-list" style="max-height:220px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:13px;column-count:2;column-gap:12px;"></div>

    <div style="margin-top:12px;">
      <label style="font-size:13px;">Note (applied to every selected student):</label><br/>
      <textarea id="ggn-note" rows="4" style="width:100%;font-family:inherit;font-size:13px;margin-top:4px;"></textarea>
    </div>

    <div style="margin-top:10px;position:relative;">
      <label style="font-size:13px;">Tag:</label><br/>
      <input type="text" id="ggn-tag-search" placeholder="Type to search (e.g. SGP, Email)..." autocomplete="off" style="width:100%;padding:6px;margin-top:4px;box-sizing:border-box;" />
      <div id="ggn-tag-dropdown" style="display:none;position:absolute;left:0;right:0;background:#fff;border:1px solid #ccc;border-radius:4px;max-height:180px;overflow-y:auto;z-index:100000;box-shadow:0 2px 8px rgba(0,0,0,0.15);"></div>
    </div>

    <div style="margin-top:14px;text-align:right;">
      <button id="ggn-cancel" style="padding:8px 14px;margin-right:8px;">Close</button>
      <button id="ggn-submit" style="padding:8px 14px;background:#29847E;color:#fff;border:none;border-radius:4px;" disabled>Submit All</button>
    </div>
    <div id="ggn-log" style="margin-top:10px;font-size:12px;white-space:pre-wrap;max-height:160px;overflow-y:auto;"></div>

    <hr style="margin:16px 0;border:none;border-top:1px solid #ddd;" />

    <h2 id="ggn-bridge-toggle" style="margin-top:0;font-size:15px;cursor:pointer;user-select:none;">\u25b6 Missing Assignment Notes</h2>
    <div id="ggn-bridge-content" style="display:none;">
      <div style="margin-bottom:8px;">
        <button type="button" id="ggn-bridge-check" style="padding:6px 12px;font-size:12px;">Check Pending Notes</button>
      </div>
      <div id="ggn-bridge-status" style="font-size:12px;color:#444;margin-bottom:8px;"></div>

      <div id="ggn-bridge-select-row" style="display:none;margin-bottom:8px;">
        <button type="button" id="ggn-bridge-select-all" style="padding:4px 10px;font-size:12px;margin-right:6px;">Select All</button>
        <button type="button" id="ggn-bridge-select-none" style="padding:4px 10px;font-size:12px;margin-right:6px;">Select None</button>
        <span id="ggn-bridge-selected-count" style="font-size:12px;color:#555;">0 selected</span>
      </div>
      <div id="ggn-bridge-matched" style="font-size:13px;max-height:260px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;padding:4px;"></div>
      <div id="ggn-bridge-unmatched" style="font-size:12px;color:#a33;margin-top:10px;"></div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" id="ggn-bridge-submit" style="padding:8px 14px;background:#29847E;color:#fff;border:none;border-radius:4px;cursor:pointer;pointer-events:auto;position:relative;z-index:100001;">Submit Checked Notes</button>
      </div>
      <div id="ggn-bridge-log" style="margin-top:10px;font-size:12px;white-space:pre-wrap;max-height:160px;overflow-y:auto;"></div>
    </div>
  `;
  document.body.appendChild(modal);

  // Drag-to-move: click and hold the title bar to reposition the panel
  // anywhere on screen. Switches from right-anchored to left-anchored
  // positioning the first time it's dragged, so it can move freely.
  (function makeDraggable() {
    const handle = modal.querySelector('#ggn-drag-handle');
    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const rect = modal.getBoundingClientRect();
      // Switch to left/top positioning based on current on-screen location,
      // so dragging works smoothly regardless of how it was positioned before.
      modal.style.left = rect.left + 'px';
      modal.style.top = rect.top + 'px';
      modal.style.right = 'auto';
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      modal.style.left = startLeft + dx + 'px';
      modal.style.top = startTop + dy + 'px';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  })();

  // Persists across popup open/close, for as long as this page stays open —
  // lets the person page through manually and build up their selection
  // across as many pages as they want, without losing earlier progress.
  const accumulatedStudents = new Map(); // lmsId -> {lmsId, userId, name}
  const selectedIds = new Set();
  let savedNote = '';
  let savedTagUuid = '';
  let savedTagLabel = '';
  let currentTagUuid = '';

  function updateSelectedCount() {
    const countEl = modal.querySelector('#ggn-selected-count');
    if (countEl) countEl.textContent = `${selectedIds.size} selected`;
  }

  function renderTagDropdown(filterText) {
    const dropdown = modal.querySelector('#ggn-tag-dropdown');
    const tags = getTagOptions();
    const filtered = filterText
      ? tags.filter((t) => t.label.toLowerCase().includes(filterText.toLowerCase()))
      : tags;

    if (filtered.length === 0) {
      dropdown.innerHTML = '<div style="padding:6px 8px;color:#888;font-size:12px;">No matching tags</div>';
    } else {
      dropdown.innerHTML = filtered
        .map(
          (t) =>
            `<div class="ggn-tag-option" data-uuid="${t.uuid}" data-label="${t.label.replace(/"/g, '&quot;')}" style="padding:6px 8px;cursor:pointer;font-size:13px;">${t.label}</div>`
        )
        .join('');
      dropdown.querySelectorAll('.ggn-tag-option').forEach((opt) => {
        opt.addEventListener('mouseenter', () => (opt.style.background = '#f0f0f0'));
        opt.addEventListener('mouseleave', () => (opt.style.background = ''));
        opt.addEventListener('mousedown', (e) => {
          // mousedown (not click) so this fires before the search box's blur hides the dropdown
          e.preventDefault();
          const searchEl = modal.querySelector('#ggn-tag-search');
          searchEl.value = opt.getAttribute('data-label');
          currentTagUuid = opt.getAttribute('data-uuid');
          dropdown.style.display = 'none';
        });
      });
    }
    dropdown.style.display = 'block';
  }

  function renderRosterList() {
    const listEl = modal.querySelector('#ggn-roster-list');
    const sorted = Array.from(accumulatedStudents.values()).sort((a, b) =>
      lastNameSortKey(a.name).localeCompare(lastNameSortKey(b.name))
    );
    listEl.innerHTML = sorted
      .map(
        (s) => `
        <label style="display:block;margin-bottom:4px;break-inside:avoid;">
          <input type="checkbox" class="ggn-student-cb" data-lms-id="${s.lmsId}" ${selectedIds.has(s.lmsId) ? 'checked' : ''} />
          ${s.name}
        </label>`
      )
      .join('');

    listEl.querySelectorAll('.ggn-student-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-lms-id');
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSelectedCount();
      });
    });

    updateSelectedCount();
  }


  function addVisibleStudents() {
    const statusEl = modal.querySelector('#ggn-status');
    const submitBtn = modal.querySelector('#ggn-submit');


    const newRows = parseRosterRowsFromHtml(document.getElementById('student-list-table')?.outerHTML || '');
    let newCount = 0;
    newRows.forEach((s) => {
      if (!accumulatedStudents.has(s.lmsId)) newCount++;
      accumulatedStudents.set(s.lmsId, s);
    });

    renderRosterList();

    statusEl.textContent = newCount > 0
      ? `Added ${newCount} new student(s) from this page — ${accumulatedStudents.size} total collected so far.`
      : `No new students found on the currently visible page — ${accumulatedStudents.size} total collected so far.`;

    submitBtn.disabled = accumulatedStudents.size === 0;
  }

  // Watches the real roster table and automatically re-scans whenever it
  // changes — since the person clicking the real pagination buttons is what
  // causes that change, this is just reacting to a genuine action, not
  // simulating one. Means no manual "check again" step is needed at all.
  let autoScanTimeout = null;
  const tableObserver = new MutationObserver(() => {
    if (modal.style.display !== 'block') return; // only bother while panel is open
    clearTimeout(autoScanTimeout);
    autoScanTimeout = setTimeout(() => addVisibleStudents(), 400); // debounce the swap settling
  });

  function startWatchingTable() {
    const container = document.getElementById('student-list-container');
    if (container) tableObserver.observe(container, { childList: true, subtree: true });
  }

  btn.addEventListener('click', () => {
    // Toggle: if already open, clicking the button again just closes it,
    // same as Close — since the panel no longer blocks the page, there's
    // no harm leaving it open across page changes.
    if (modal.style.display === 'block') {
      modal.style.display = 'none';
      return;
    }
    modal.style.display = 'block';

    const noteEl = modal.querySelector('#ggn-note');
    const tagSearchOpenEl = modal.querySelector('#ggn-tag-search');

    tagSearchOpenEl.value = savedTagLabel;
    currentTagUuid = savedTagUuid;

    noteEl.value = savedNote;

    addVisibleStudents();
    startWatchingTable();
  });

  const tagSearchEl = modal.querySelector('#ggn-tag-search');
  tagSearchEl.addEventListener('input', () => {
    currentTagUuid = ''; // typing invalidates whatever was previously selected
    renderTagDropdown(tagSearchEl.value);
  });
  tagSearchEl.addEventListener('focus', () => {
    renderTagDropdown(tagSearchEl.value);
  });
  tagSearchEl.addEventListener('blur', () => {
    // Slight delay so a click on a dropdown option (mousedown) registers first
    setTimeout(() => {
      modal.querySelector('#ggn-tag-dropdown').style.display = 'none';
    }, 150);
  });

  modal.querySelector('#ggn-cancel').addEventListener('click', () => {
    // Save the in-progress note/tag so closing and reopening later (or just
    // paging to the next page) doesn't lose what was already typed.
    savedNote = modal.querySelector('#ggn-note').value;
    savedTagUuid = currentTagUuid;
    savedTagLabel = modal.querySelector('#ggn-tag-search').value;
    modal.style.display = 'none';
  });
  modal.querySelector('#ggn-select-all').addEventListener('click', () => {
    modal.querySelectorAll('.ggn-student-cb').forEach((cb) => {
      cb.checked = true;
      selectedIds.add(cb.getAttribute('data-lms-id'));
    });
    updateSelectedCount();
  });
  modal.querySelector('#ggn-select-none').addEventListener('click', () => {
    modal.querySelectorAll('.ggn-student-cb').forEach((cb) => {
      cb.checked = false;
      selectedIds.delete(cb.getAttribute('data-lms-id'));
    });
    updateSelectedCount();
  });

  modal.querySelector('#ggn-submit').addEventListener('click', async () => {
    const submitBtn = modal.querySelector('#ggn-submit');
    const logEl = modal.querySelector('#ggn-log');
    const noteText = modal.querySelector('#ggn-note').value.trim();
    const tagUuid = currentTagUuid;

    if (!noteText) {
      logEl.textContent = 'Write a note first.';
      return;
    }

    if (selectedIds.size === 0) {
      logEl.textContent = 'Select at least one student first.';
      return;
    }

    const selectedStudents = Array.from(accumulatedStudents.values()).filter((s) => selectedIds.has(s.lmsId));

    submitBtn.disabled = true;
    logEl.textContent = '';

    let successCount = 0;
    let failCount = 0;

    for (const student of selectedStudents) {
      try {
        await submitNote(student, noteText, tagUuid);
        successCount++;
        logEl.textContent += `✅ ${student.name}\n`;
      } catch (err) {
        failCount++;
        logEl.textContent += `❌ ${student.name}: ${err.message}\n`;
      }
      logEl.scrollTop = logEl.scrollHeight;
      await sleep(300);
    }

    logEl.textContent += `\nDone: ${successCount} succeeded, ${failCount} failed.`;
    submitBtn.disabled = false;
  });

  // =====================================================================
  // PENDING NOTES BRIDGE (Progress Reports -> Grade Guardian)
  // =====================================================================
  // IMPORTANT: The Bulk Add Note workflow above is intentionally unchanged.
  //
  // The Progress Reports Apps Script queues communication notes in the
  // "Pending Grade Guardian Notes" sheet. Its deployed Web App exposes ONLY
  // that queue as JSON.
  //
  // Matching order:
  //   1) Canvas User ID from the sheet -> Grade Guardian data-user-lms-id
  //   2) Exact full-name match (keeps a two-word last name intact)
  //   3) First + last name only -- trusted ONLY when exactly one student fits
  //
  // Anything ambiguous is shown as unmatched rather than risking a note on
  // the wrong student's record.

  // ---------------------------------------------------------------------
  // BRIDGE SETUP — fill in these TWO values after deploying the Apps Script
  // web app. Do not include ?secret= in WEB_APP_URL.
  // ---------------------------------------------------------------------
  const WEB_APP_URL = 'UPDATE';
  const BRIDGE_SHARED_SECRET = 'UPDATE';

  // Bridge tags: choose by the note's communication method.
  // Keep existing email notes tagged Email; group texts use Text Message.
  const BRIDGE_EMAIL_TAG_UUID = 'e8a24169-53d9-4d5d-a2a5-d618853fb785';
  const BRIDGE_TEXT_TAG_UUID = '90221b9c-f0d0-4cfa-8d53-2777c3afede4';

  function getBridgeNoteTagUuid_(noteText) {
    const note = String(noteText || '');

    // Treat all of our text-message communication notes as Text Message.
    // This covers both missing-assignment group texts and PE absence texts.
    if (/\b(?:group\s+text|text\s+message|sms|text\s+sent|absence\s+notification\s+text)\b/i.test(note)) {
      return BRIDGE_TEXT_TAG_UUID;
    }

    // Anything else from the Progress Reports bridge stays tagged Email.
    return BRIDGE_EMAIL_TAG_UUID;
  }
  const SUBMITTED_IDS_KEY = 'ggn-bridge-submitted-note-ids';

  function bridgeIsConfigured_() {
    return (
      WEB_APP_URL &&
      WEB_APP_URL.indexOf('PASTE_YOUR') !== 0 &&
      BRIDGE_SHARED_SECRET &&
      BRIDGE_SHARED_SECRET.indexOf('PASTE_YOUR') !== 0
    );
  }

  function buildBridgeUrl_(params = {}) {
    if (!bridgeIsConfigured_()) return '';

    const pairs = [
      'secret=' + encodeURIComponent(BRIDGE_SHARED_SECRET)
    ];

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
    });

    return WEB_APP_URL + (WEB_APP_URL.includes('?') ? '&' : '?') + pairs.join('&');
  }

  /**
   * GET request via Tampermonkey's GM_xmlhttpRequest.
   * Apps Script Web Apps can redirect to googleusercontent.com; this avoids
   * normal page-fetch CORS problems.
   */
  function gmFetchJson_(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        onload: (res) => {
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(
              new Error(
                `Response wasn't valid JSON (got: ${String(res.responseText || '').slice(0, 120)})`
              )
            );
          }
        },
        onerror: () => reject(new Error('Network error fetching the Progress Reports bridge')),
        ontimeout: () => reject(new Error('Progress Reports bridge request timed out'))
      });
    });
  }

  /**
   * "Last, First Middle..." -> "First Middle... Last", lowercased, accents and
   * punctuation removed, WITHOUT dropping any name parts. This keeps a
   * two-word last name intact ("Lopez Villeda, Jostin" -> "jostin lopez
   * villeda") so it equals Grade Guardian's plain "Jostin Lopez Villeda".
   */
  function normalizeFullNameForBridge_(s) {
    let raw = String(s || '').trim();
    if (raw.indexOf(',') !== -1) {
      const parts = raw.split(',');
      const last = parts[0].trim();
      const rest = parts.slice(1).join(',').trim();
      raw = `${rest} ${last}`.trim();
    }
    let n = raw.toLowerCase();
    n = n.normalize ? n.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : n;
    n = n.replace(/[.,'’]/g, '');
    n = n.replace(/-/g, ' ');
    n = n.replace(/\s+/g, ' ').trim();
    n = n.replace(/\b(jr|sr|ii|iii|iv)\.?$/i, '').trim();
    return n.replace(/\s+/g, ' ').trim();
  }

  /**
   * Collapses an already-normalized full name to just its first and last
   * token. Used only as a SECOND attempt (a middle name on one side only);
   * never first, so a two-word last name is not mistaken for a middle name.
   */
  function firstLastOnlyForBridge_(normalizedFullName) {
    const tokens = normalizedFullName.split(' ').filter(Boolean);
    if (tokens.length <= 2) return normalizedFullName;
    return tokens[0] + ' ' + tokens[tokens.length - 1];
  }

  function getSubmittedNoteIds_() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SUBMITTED_IDS_KEY) || '[]'));
    } catch (e) {
      return new Set();
    }
  }

  function markNoteIdSubmitted_(noteId) {
    const ids = getSubmittedNoteIds_();
    ids.add(noteId);
    localStorage.setItem(SUBMITTED_IDS_KEY, JSON.stringify(Array.from(ids)));
  }

  /**
   * After Grade Guardian accepts the note, tell the Apps Script web app to
   * remove that queue row. Local storage is also retained as a second guard.
   */
  function reportNoteSubmitted_(noteId) {
    const url = buildBridgeUrl_({
      action: 'markSubmitted',
      noteId
    });

    if (!url) return;

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 20000,
      onload: () => {},
      onerror: () => {},
      ontimeout: () => {}
    });
  }

  let pendingMatched = []; // [{note, student, matchMethod}]

  function updateBridgeSelectedCount_() {
    const countEl = modal.querySelector('#ggn-bridge-selected-count');
    const submitBtn = modal.querySelector('#ggn-bridge-submit');

    const checkedCount = modal.querySelectorAll('.ggn-bridge-cb:checked').length;

    if (countEl) {
      countEl.textContent = `${checkedCount} selected`;
    }

    if (submitBtn) {
      const shouldEnable = checkedCount > 0;
      submitBtn.disabled = !shouldEnable;

      if (shouldEnable) {
        submitBtn.removeAttribute('disabled');
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
        submitBtn.style.pointerEvents = 'auto';
      } else {
        submitBtn.setAttribute('disabled', 'disabled');
        submitBtn.style.opacity = '0.55';
        submitBtn.style.cursor = 'not-allowed';
      }
    }
  }

  function findBridgeStudentMatch_(note, students = Array.from(accumulatedStudents.values())) {

    // SAFEST MATCH: Canvas ID from Progress Reports = GG data-user-lms-id
    const targetCanvasId = String(note.canvasUserId || '').trim();

    if (targetCanvasId) {
      const idMatches = students.filter(
        (s) => String(s.lmsId || '').trim() === targetCanvasId
      );

      if (idMatches.length === 1) {
        return {
          student: idMatches[0],
          matchMethod: 'Canvas User ID'
        };
      }

      // More than one exact ID should never happen; treat as unsafe instead
      // of guessing.
      if (idMatches.length > 1) {
        return null;
      }
    }

    // FALLBACK, by name.
    // Tier 1: exact full-name match (keeps a two-word last name intact).
    const targetFull = normalizeFullNameForBridge_(note.studentName);
    if (!targetFull) return null;
    const exactMatches = students.filter(
      (s) => normalizeFullNameForBridge_(s.name) === targetFull
    );
    if (exactMatches.length === 1) {
      return {
        student: exactMatches[0],
        matchMethod: 'Exact name fallback'
      };
    }
    // More than one exact name match is ambiguous -- never guess.
    if (exactMatches.length > 1) return null;
    // Tier 2: first + last name only (a middle name on one side only).
    // Trusted ONLY when exactly one student fits.
    const targetShort = firstLastOnlyForBridge_(targetFull);
    const shortMatches = students.filter(
      (s) => firstLastOnlyForBridge_(normalizeFullNameForBridge_(s.name)) === targetShort
    );
    if (shortMatches.length === 1) {
      return {
        student: shortMatches[0],
        matchMethod: 'First + last name (only one fit)'
      };
    }
    return null;
  }

  // Pending Notes only: Grade Guardian's roster is served by a form-encoded
  // POST /detective/dashboard/table/ with 'section' and 'page'. Fetch each
  // page without moving the UI or touching Manual Bulk Add Notes selections.
  function currentBridgeSection_() {
    const context = getListContext();
    if (context && typeof context === 'object') {
      for (const key of ['section', 'section_id', 'sectionId', 'current_section', 'currentSection']) {
        const value = context[key];
        if (/^\d+$/.test(String(value ?? ''))) return String(value);
        if (value && typeof value === 'object') {
          const id = value.id ?? value.pk;
          if (/^\d+$/.test(String(id ?? ''))) return String(id);
        }
      }
    }
    // The active section selector may be a select, hidden input or link.
    for (const selector of [
      'select[name="section"]', 'input[name="section"]',
      '#id_section', '[data-section-id].active',
      '[data-section-id][aria-selected="true"]'
    ]) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const value = el.getAttribute('data-section-id') || el.value;
      if (/^\d+$/.test(String(value ?? ''))) return String(value);
    }
    const urlSection = new URL(location.href).searchParams.get('section');
    if (/^\d+$/.test(String(urlSection ?? ''))) return urlSection;
    return null;
  }

  async function fetchSectionRosterInBackground_() {
    const sectionId = currentBridgeSection_();
    if (!sectionId) {
      throw new Error('Could not identify the currently selected section. No cross-class matches were attempted.');
    }
    const csrf = getFormFieldValue('csrfmiddlewaretoken') || getCookie('csrftoken');
    const lti = getFormFieldValue('ltimiddlewaretoken');
    if (!csrf || !lti) {
      throw new Error('Grade Guardian roster request credentials are not present on this page. Refresh the dashboard and try again.');
    }
    const collected = new Map();
    const fingerprints = new Set();
    const status = modal.querySelector('#ggn-bridge-status');
    const maxPages = 150;
    let scannedPages = 0;
    let complete = false;
    let consecutiveRepeated = 0;
    const tableUrl = 'https://prd-m.aspiredu.com/detective/dashboard/table/';

    for (let page = 1; page <= maxPages; page++) {
      const form = new URLSearchParams();
      form.append('csrfmiddlewaretoken', csrf);
      form.append('ltimiddlewaretoken', lti);
      form.append('dashboard', '');
      form.append('section', sectionId);
      form.append('show_dashboard', 'True');
      form.append('flexible_filter', '');
      form.append('q', '');
      form.append('page', String(page));
      const response = await fetch(tableUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRFToken': getCookie('csrftoken') || csrf,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01'
        },
        body: form.toString()
      });
      if (!response.ok) throw new Error(`Roster page ${page} returned HTTP ${response.status}.`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.querySelector('#student-list-table')) {
        throw new Error(`Roster page ${page} did not return a student table. Check section credentials and filters.`);
      }
      const rows = parseRosterRowsFromHtml(html);
      scannedPages++;
      if (!rows.length) { complete = true; break; }
      const fingerprint = rows.map(s => s.lmsId).join('|');
      if (fingerprints.has(fingerprint)) {
        consecutiveRepeated++;
        // Servers sometimes return the last page when asked past the end.
        if (consecutiveRepeated >= 2) { complete = true; break; }
      } else {
        consecutiveRepeated = 0;
      }
      fingerprints.add(fingerprint);
      let added = 0;
      for (const student of rows) {
        if (!collected.has(String(student.lmsId))) added++;
        collected.set(String(student.lmsId), student);
      }
      if (status) status.textContent = `Retrieving section ${sectionId}: ${collected.size} students from ${scannedPages} roster page(s)...`;
      if (added === 0 && consecutiveRepeated >= 1) { complete = true; break; }
      // Stop only on an empty/repeated page; some classes have short pages.
      await sleep(70);
    }
    return {
      students: Array.from(collected.values()),
      scannedPages,
      complete,
      sectionId,
      scrollSteps: 0
    };
  }

  async function fetchAndMatchPendingNotes() {
    const statusEl = modal.querySelector('#ggn-bridge-status');
    const matchedEl = modal.querySelector('#ggn-bridge-matched');
    const unmatchedEl = modal.querySelector('#ggn-bridge-unmatched');
    const submitBtn = modal.querySelector('#ggn-bridge-submit');
    const selectRowEl = modal.querySelector('#ggn-bridge-select-row');

    if (!bridgeIsConfigured_()) {
      statusEl.textContent =
        'Bridge setup is incomplete. Paste the Apps Script Web App URL and BRIDGE_SHARED_SECRET into the Tampermonkey script.';
      return;
    }

    statusEl.textContent = 'Fetching pending notes...';

    let notes;
    try {
      const data = await gmFetchJson_(buildBridgeUrl_());
      if (data.error) throw new Error(data.error);
      notes = data.notes || [];
    } catch (err) {
      statusEl.textContent = `Couldn't fetch pending notes: ${err.message}`;
      return;
    }

    const submittedIds = getSubmittedNoteIds_();
    const unhandled = notes.filter((n) => !submittedIds.has(n.noteId));
    statusEl.textContent = 'Fetching the current class roster in the background...';
    let roster;
    try {
      roster = await fetchSectionRosterInBackground_();
    } catch (err) {
      roster = { students: [], scannedPages: 0, complete: false, sectionId: 'unknown', scrollSteps: 0 };
      statusEl.textContent = 'Background roster scan failed: ' + err.message;
    }
    // Pending Notes are matched strictly against this section's fetched roster.
    // Never mix in Manual Bulk Add Notes students collected in other sections.
    const bridgeStudents = roster.students;

    pendingMatched = [];
    const unmatched = [];

    unhandled.forEach((note) => {
      const match = findBridgeStudentMatch_(note, bridgeStudents);

      if (match) {
        pendingMatched.push({
          note,
          student: match.student,
          matchMethod: match.matchMethod
        });
      } else {
        unmatched.push({
          name: note.studentName || '(unknown student)',
          canvasUserId: note.canvasUserId || ''
        });
      }
    });

    matchedEl.innerHTML =
      pendingMatched.length === 0
        ? '<div style="color:#888;padding:8px;">No pending notes matched the class roster retrieved so far.</div>'
        : pendingMatched
            .map(
              (m, idx) => `
        <label style="display:block;padding:8px;margin-bottom:4px;border-radius:4px;background:#f7f7f8;cursor:pointer;">
          <input type="checkbox" class="ggn-bridge-cb" data-idx="${idx}" checked style="margin-right:6px;vertical-align:top;" />
          <span style="display:inline-block;width:calc(100% - 24px);vertical-align:top;">
            <strong style="display:block;">${m.student.name}</strong>
            <span style="display:block;font-size:11px;color:#29847E;margin:2px 0 4px 0;">
              Matched by: ${m.matchMethod}${m.note.canvasUserId ? ` · Canvas ID ${m.note.canvasUserId}` : ''}
            </span>
            <span style="font-size:12px;color:#666;">${m.note.noteText}</span>
          </span>
        </label>`
            )
            .join('');

    matchedEl.querySelectorAll('.ggn-bridge-cb').forEach((cb) => {
      cb.addEventListener('change', updateBridgeSelectedCount_);
    });

    selectRowEl.style.display = pendingMatched.length > 0 ? 'block' : 'none';
    updateBridgeSelectedCount_();

    unmatchedEl.textContent =
      unmatched.length > 0
        ? `Not matched in this section yet: ${unmatched
            .map((u) => u.canvasUserId ? `${u.name} (Canvas ID ${u.canvasUserId})` : u.name)
            .join(', ')}. The roster scan could not verify these students; no note will be submitted for them.`
        : '';

    statusEl.textContent =
      `${pendingMatched.length} matched, ` +
      `${unmatched.length} unmatched, ` +
      `${submittedIds.size} already submitted previously. ` +
      `Roster: ${bridgeStudents.length} students retrieved across ${roster.scannedPages} page(s) for section ${roster.sectionId || 'unknown'}.` +
      (unmatched.length ? ' Some students could not be verified against this roster; no notes were submitted for them.' : '') +
      (!roster.complete ? ' Full roster coverage could not be confirmed.' : '');
  }

  modal.querySelector('#ggn-bridge-toggle').addEventListener('click', () => {
    const content = modal.querySelector('#ggn-bridge-content');
    const toggleHeading = modal.querySelector('#ggn-bridge-toggle');
    const opening = content.style.display === 'none';

    content.style.display = opening ? 'block' : 'none';
    toggleHeading.textContent =
      (opening ? '\u25bc ' : '\u25b6 ') + 'Missing Assignment Notes';
  });

  modal.querySelector('#ggn-bridge-check').addEventListener('click', () => {
    // Collect the currently visible roster rows first.
    addVisibleStudents();
    startWatchingTable();
    fetchAndMatchPendingNotes();
  });

  modal.querySelector('#ggn-bridge-select-all').addEventListener('click', () => {
    modal.querySelectorAll('.ggn-bridge-cb').forEach((cb) => {
      cb.checked = true;
    });
    updateBridgeSelectedCount_();
  });

  modal.querySelector('#ggn-bridge-select-none').addEventListener('click', () => {
    modal.querySelectorAll('.ggn-bridge-cb').forEach((cb) => {
      cb.checked = false;
    });
    updateBridgeSelectedCount_();
  });

  let bridgeSubmitRunning = false;

  async function submitCheckedBridgeNotes_(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (bridgeSubmitRunning) return;

    const submitBtn = modal.querySelector('#ggn-bridge-submit');
    const logEl = modal.querySelector('#ggn-bridge-log');
    const statusEl = modal.querySelector('#ggn-bridge-status');

    const checked = Array.from(modal.querySelectorAll('.ggn-bridge-cb'))
      .filter((cb) => cb.checked)
      .map((cb) => pendingMatched[parseInt(cb.getAttribute('data-idx'), 10)])
      .filter(Boolean);

    if (checked.length === 0) {
      logEl.textContent = 'Nothing checked.';
      return;
    }

    if (bridgeSubmitRunning) return;
    bridgeSubmitRunning = true;
    submitBtn.disabled = true;
    logEl.textContent = '';

    let successCount = 0;
    let failCount = 0;

    for (const item of checked) {
      try {
        // Reuses the SAME submitNote() function as Bulk Add Note.
        // The working bulk-note submit behavior is not changed.
        await submitNote(
          item.student,
          item.note.noteText,
          getBridgeNoteTagUuid_(item.note.noteText)
        );

        markNoteIdSubmitted_(item.note.noteId);
        reportNoteSubmitted_(item.note.noteId);

        successCount++;
        logEl.textContent += `✅ ${item.student.name}\n`;
      } catch (err) {
        failCount++;
        logEl.textContent += `❌ ${item.student.name}: ${err.message}\n`;
      }

      logEl.scrollTop = logEl.scrollHeight;
      await sleep(300);
    }

    logEl.textContent += `\nDone: ${successCount} succeeded, ${failCount} failed.`;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Checked Notes';
    if (statusEl) {
      statusEl.textContent = `Submission finished: ${successCount} succeeded, ${failCount} failed.`;
    }

    // Successful rows disappear from the Apps Script queue after the
    // markSubmitted callback completes.
    await sleep(500);
    fetchAndMatchPendingNotes();

    bridgeSubmitRunning = false;
  }

  const bridgeSubmitBtn = modal.querySelector('#ggn-bridge-submit');

  // Use both click and mousedown. Some Grade Guardian layouts can swallow
  // a normal click on docked overlay controls, while mousedown still reaches
  // the button. The running guard prevents duplicate submissions.
  bridgeSubmitBtn.addEventListener('mousedown', (event) => {
    submitCheckedBridgeNotes_(event);
  });

  bridgeSubmitBtn.addEventListener('click', (event) => {
    submitCheckedBridgeNotes_(event);
  });

  // =====================================================================
  // DIRECT GRADE GUARDIAN COMMUNICATION -> STUDENT MONITORING HUB
  // Added in 2.9.0.
  // IMPORTANT: Existing 2.8 Bulk Add Notes and Pending Notes behavior above
  // is unchanged. This is an additional read-only Grade Guardian sync.
  // =====================================================================

  const GG_SYNC_AUTHOR_NAME = 'UPDATE';
  const GG_SYNC_BUTTON_ID = 'ggn-sync-communication-hub';
  let ggCommunicationSyncRunning = false;

  function normalizeGgSyncAuthor_(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function friendlyGgMethodFromTags_(tags) {
    const text = (Array.isArray(tags) ? tags.join(' | ') : String(tags || '')).toLowerCase();

    if (text.includes('staff to staff')) return { method: 'Staff to Staff', type: 'Neutral' };
    if (text.includes('unsuccessful')) return { method: 'Unsuccessful', type: 'Unsuccessful' };

    if (
      text.includes('successful student/guardian zoom') ||
      text.includes('successful guardian zoom')
    ) return { method: 'Guardian Zoom', type: 'Successful' };

    if (
      text.includes('successful student/guardian phone') ||
      text.includes('successful guardian phone')
    ) return { method: 'Guardian Phone', type: 'Successful' };

    if (text.includes('successful student zoom')) {
      return { method: 'Student Zoom', type: 'Successful' };
    }

    if (text.includes('successful student phone')) {
      return { method: 'Student Phone', type: 'Successful' };
    }

    if (text.includes('successful intervention')) {
      return { method: 'Successful Intervention', type: 'Successful' };
    }

    if (text.includes('text message')) {
      return { method: 'Text Message', type: 'Text' };
    }

    if (text.includes('email')) {
      return { method: 'Email', type: 'Email' };
    }

    return {
      method: Array.isArray(tags) ? tags.join(' | ') : String(tags || ''),
      type: 'Other'
    };
  }

  async function fetchGgActivityForStudent_(student) {
    const csrfCookie = getCookie('csrftoken');
    const ltiToken = getFormFieldValue('ltimiddlewaretoken');

    const headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };

    if (csrfCookie) headers['X-CSRFToken'] = csrfCookie;
    if (ltiToken) headers['X-LTIToken'] = ltiToken;

    const response = await fetch(
      `https://prd-m.aspiredu.com/detective/api/user/${encodeURIComponent(student.lmsId)}/activity/`,
      {
        method: 'GET',
        credentials: 'same-origin',
        headers
      }
    );

    if (!response.ok) {
      throw new Error(`Activity request failed (${response.status}).`);
    }

    return response.json();
  }

  function buildHubSyncRecords_(student, activity) {
    const wantedAuthor = normalizeGgSyncAuthor_(GG_SYNC_AUTHOR_NAME);
    const records = [];

    (activity.notes || []).forEach((note) => {
      if (normalizeGgSyncAuthor_(note.author_name) !== wantedAuthor) return;

      const tags = Array.isArray(note.tags) ? note.tags : [];
      const classified = friendlyGgMethodFromTags_(tags);

      records.push({
        recordKey: `GG_NOTE_${note.id}`,
        timestamp: note.created || '',
        studentName: student.name || '',
        canvasUserId: String(student.lmsId || ''),
        course: note.course_name || '',
        method: classified.method,
        type: classified.type,
        message: note.note || '',
        tags: tags.join(' | '),
        author: note.author_name || '',
        source: 'Grade Guardian Note'
      });
    });

    // Grade Guardian/Canvas messages authored by Courtney are retained as Email.
    (activity.student_messages || []).forEach((message) => {
      if (normalizeGgSyncAuthor_(message.author_name) !== wantedAuthor) return;

      records.push({
        recordKey: `GG_MESSAGE_${message.id}`,
        timestamp: message.sent || '',
        studentName: student.name || '',
        canvasUserId: String(student.lmsId || ''),
        course: message.course_name || '',
        method: 'Email',
        type: 'Email',
        message: message.note_text || '',
        tags: 'Email',
        author: message.author_name || '',
        source: 'Grade Guardian Student Message'
      });
    });

    return records;
  }

  function postGgCommunicationChunkToHub_(records, finalize = false) {
    return new Promise((resolve, reject) => {
      if (!bridgeIsConfigured_()) {
        reject(new Error('Bridge setup is incomplete.'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: WEB_APP_URL,
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify({
          action: 'syncGGCommunication',
          secret: BRIDGE_SHARED_SECRET,
          records,
          finalize
        }),
        timeout: 120000,
        onload: (response) => {
          try {
            const parsed = JSON.parse(response.responseText || '{}');

            if (parsed.error || parsed.status === 'error') {
              throw new Error(parsed.message || parsed.error || 'Hub rejected the sync.');
            }

            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error('Could not reach the Student Monitoring Hub web app.')),
        ontimeout: () => reject(new Error('The Student Monitoring Hub sync timed out.'))
      });
    });
  }

  function refreshHubViewsAfterGgSync_() {
    const url = buildBridgeUrl_({
      action: 'refreshGGViews'
    });

    if (!url) return;

    /*
     * Do not await this request. The communication records are already safely
     * stored. This merely asks Apps Script to rebuild the slower monitoring
     * views afterward, without making the Grade Guardian sync wait for them.
     */
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 120000,
      onload: () => {},
      onerror: () => {},
      ontimeout: () => {}
    });
  }

  async function syncGgCommunicationToHub_() {
    if (ggCommunicationSyncRunning) return;

    const button = document.getElementById(GG_SYNC_BUTTON_ID);

    try {
      ggCommunicationSyncRunning = true;

      if (button) {
        button.disabled = true;
        button.textContent = 'Finding students...';
      }

      // Reuse the WORKING 2.8 section-roster retrieval exactly as-is.
      const rosterResult = await fetchSectionRosterInBackground_();
      const students = rosterResult.students || [];

      if (!students.length) {
        throw new Error('No students were found in the current Grade Guardian section.');
      }

      let processed = 0;
      let failed = 0;
      let allRecords = [];

      for (const student of students) {
        if (button) {
          button.textContent = `Reading ${processed + 1}/${students.length}...`;
        }

        try {
          const activity = await fetchGgActivityForStudent_(student);
          allRecords = allRecords.concat(
            buildHubSyncRecords_(student, activity)
          );
        } catch (error) {
          failed++;
        }

        processed++;
        await sleep(80);
      }

      if (button) {
        button.textContent = 'Sending to Hub...';
      }

      let added = 0;
      let skipped = 0;
      const chunkSize = 40;

      /*
       * Send smaller batches so the web app can respond quickly.
       * The slower monitoring-view rebuild happens in a separate,
       * fire-and-forget request after every data batch is finished.
       */
      if (allRecords.length === 0) {
        await postGgCommunicationChunkToHub_([]);
      } else {
        for (let i = 0; i < allRecords.length; i += chunkSize) {
          const chunk = allRecords.slice(i, i + chunkSize);

          const response =
            await postGgCommunicationChunkToHub_(chunk);

          const result = response.result || {};

          added += Number(result.added || 0);
          skipped += Number(result.skipped || 0);
        }
      }

      // Request a separate Hub refresh without blocking the completed data sync.
      // The deployed Apps Script must support GET action=refreshGGViews.
      refreshHubViewsAfterGgSync_();

      alert(
        `Grade Guardian communication sync complete.\n\n` +
        `${students.length} student(s) checked\n` +
        `${allRecords.length} communication record(s) found for ${GG_SYNC_AUTHOR_NAME}\n` +
        `${added} new record(s) added to the Hub\n` +
        `${skipped} already stored / skipped\n` +
        `${failed} student activity request(s) failed\n\n` +
        `Weekly Contact Priority and Weekly Totals refresh was requested. ` +
        `Check those tabs shortly to confirm that it finished.`
      );

    } catch (error) {
      alert(
        'Grade Guardian communication sync could not finish:\n\n' +
        (error && error.message ? error.message : String(error))
      );

    } finally {
      ggCommunicationSyncRunning = false;

      if (button) {
        button.disabled = false;
        button.textContent = 'Sync GG Communication → Hub';
      }
    }
  }


  const ggSyncButton =
    modal.querySelector('#ggn-sync-communication-hub');

  if (ggSyncButton) {
    ggSyncButton.addEventListener(
      'click',
      syncGgCommunicationToHub_
    );
  }
})();
