// ==UserScript==
// @name         Grade Guardian Bulk Notes
// @namespace    odyssey-gg-bulk-notes
// @version      1.0
// @description  Pick students from the full roster, write one note + tag, and submit it individually to each selected student — entirely via background requests, no clicking through the UI.
// @match        https://prd-m.aspiredu.com/*
// @run-at       document-idle
// @grant        none
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
    padding: '10px 14px', background: '#EF6C00', color: '#fff', border: 'none',
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
      <button id="ggn-submit" style="padding:8px 14px;background:#EF6C00;color:#fff;border:none;border-radius:4px;" disabled>Submit All</button>
    </div>
    <div id="ggn-log" style="margin-top:10px;font-size:12px;white-space:pre-wrap;max-height:160px;overflow-y:auto;"></div>
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
})();
