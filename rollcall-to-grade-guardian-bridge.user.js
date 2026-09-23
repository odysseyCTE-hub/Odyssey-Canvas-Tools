// ==UserScript==
// @name         Roll Call to Grade Guardian Bridge for Absences
// @namespace    odyssey-attendance-tool-bridge
// @version      1.0
// @description  Send today's absent students from Roll Call straight into Grade Guardian, pre-selected (never clicks Send).
// @match        https://rollcall.instructure.com/*
// @match        https://prd-m.aspiredu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'pendingAbsentList';

  // Assumption: Grade Guardian's external tool ID is the same across all of
  // your courses (119), only the course_id changes. If it's ever installed
  // per-course with a different ID, this URL will need adjusting.
  const GRADE_GUARDIAN_TOOL_ID = '119';

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Reads whatever date Roll Call's own page is currently displaying (e.g.
  // "Fri Sep 04") and converts it to YYYY-MM-DD, so scrolling to a different
  // day actually changes what gets sent. The page only shows month/day, not
  // year, so this assumes the current year — fine for normal use within a
  // single school year, but worth knowing if scrolling across a year boundary.
  function getVisiblePageDate() {
    const el = document.getElementById('date');
    if (!el) return null;
    const text = el.textContent.trim().replace(/\s+/g, ' '); // e.g. "Fri Sep 04"
    const match = text.match(/([A-Za-z]{3})\s+(\d{1,2})/);
    if (!match) return null;
    const monthAbbr = match[1];
    const day = parseInt(match[2], 10);
    const parsed = new Date(`${monthAbbr} ${day}, ${new Date().getFullYear()}`);
    if (isNaN(parsed.getTime())) return null;
    return toISODate(parsed);
  }

  // =======================================================================
  // ROLL CALL SIDE — reads the currently-displayed day's absent students, hands them off
  // =======================================================================
  if (location.hostname === 'rollcall.instructure.com') {
    const btn = document.createElement('button');
    btn.textContent = 'Send Absent List → Grade Guardian';
    Object.assign(btn.style, {
      position: 'fixed', top: '210px', right: '10px', zIndex: 99999,
      padding: '10px 14px', background: '#7B1FA2', color: '#fff', border: 'none',
      borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontFamily: 'sans-serif'
    });
    document.body.appendChild(btn);

    const statusBox = document.createElement('div');
    Object.assign(statusBox.style, {
      position: 'fixed', top: '250px', right: '10px', zIndex: 99999,
      maxWidth: '260px', fontSize: '12px', fontFamily: 'sans-serif',
      background: '#fff', border: '1px solid #ccc', borderRadius: '4px',
      padding: '8px', display: 'none'
    });
    document.body.appendChild(statusBox);

    btn.addEventListener('click', async () => {
      statusBox.style.display = 'block';
      statusBox.textContent = 'Checking attendance for the currently displayed date...';

      const sectionMatch = location.pathname.match(/sections\/(\d+)/);
      const sectionId = sectionMatch ? sectionMatch[1] : null;
      if (!sectionId) {
        statusBox.textContent = 'Could not determine the section from this page\'s URL.';
        return;
      }

      const classDate = getVisiblePageDate() || toISODate(new Date());
      let roster;
      try {
        const res = await fetch(`https://rollcall.instructure.com/statuses?section_id=${sectionId}&class_date=${classDate}`, {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        roster = await res.json();
      } catch (err) {
        statusBox.textContent = 'Error fetching attendance: ' + err.message;
        return;
      }

      const absentStudents = roster.filter((r) => r.attendance === 'absent');
      if (absentStudents.length === 0) {
        statusBox.textContent = `No students marked Absent for ${classDate} yet.`;
        return;
      }

      const courseId = absentStudents[0].course_id;
      const names = absentStudents.map((r) => r.student.name);

      GM_setValue(STORAGE_KEY, JSON.stringify({ names, sourceDate: classDate, createdAt: Date.now() }));

      statusBox.textContent = `Sending ${names.length} absent student(s) to Grade Guardian: ${names.join(', ')}`;
      window.open(`https://odysseyonlinelearning.instructure.com/courses/${courseId}/external_tools/${GRADE_GUARDIAN_TOOL_ID}`, '_blank');
    });
  }

  // =======================================================================
  // GRADE GUARDIAN SIDE — picks up the handed-off list, selects each student
  // =======================================================================
  if (location.hostname === 'prd-m.aspiredu.com') {
    const SEARCH_RESULT_TIMEOUT_MS = 3000;
    const POLL_INTERVAL_MS = 100;
    const DELAY_BETWEEN_STUDENTS_MS = 900;

    function normalizeName(str) {
      return String(str || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function waitFor(checkFn, timeoutMs) {
      return new Promise((resolve) => {
        const start = Date.now();
        const interval = setInterval(() => {
          const result = checkFn();
          if (result) {
            clearInterval(interval);
            resolve(result);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            resolve(null);
          }
        }, POLL_INTERVAL_MS);
      });
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Types one character at a time with real keydown/keypress/input/keyup
    // events, rather than setting .value in one shot — some autocomplete
    // components only respond to something that looks like genuine typing.
    async function typeIntoField(field, text) {
      field.click();
      field.focus();
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);

      for (const char of text) {
        field.value += char;
        field.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        await sleep(40);
      }
    }

    async function selectStudent(name) {
      const searchBox = document.getElementById('q');
      if (!searchBox) return { name, outcome: 'error', detail: 'Search box (#q) not found on this page.' };

      await typeIntoField(searchBox, name);

      // Enter is what actually filters the student list — not the
      // autocomplete dropdown click, which is a separate, less reliable path.
      searchBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      searchBox.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
      searchBox.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));

      const target = normalizeName(name);

      // Find the checkbox directly by its aria-label ("Select First Last"),
      // rather than depending on the autocomplete dropdown at all.
      const matches = await waitFor(() => {
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][aria-label^="Select "]'));
        const found = checkboxes.filter((cb) => {
          const label = normalizeName(cb.getAttribute('aria-label').replace(/^select /i, ''));
          return label.includes(target) || target.includes(label);
        });
        return found.length > 0 ? found : null;
      }, SEARCH_RESULT_TIMEOUT_MS);

      if (!matches) return { name, outcome: 'not_found', detail: 'No matching student appeared after pressing Enter.' };
      if (matches.length > 1) return { name, outcome: 'ambiguous', detail: `${matches.length} students matched — needs manual selection.` };

      const targetLabel = matches[0].getAttribute('aria-label');

      // The list may still re-render as it settles — don't trust a single
      // click, re-fetch by this same aria-label each attempt and verify it
      // actually stuck before moving on.
      let confirmedChecked = false;
      const MAX_ATTEMPTS = 5;
      const findByLabel = () =>
        Array.from(document.querySelectorAll('input[type="checkbox"]')).find(
          (cb) => cb.getAttribute('aria-label') === targetLabel
        );

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const freshCheckbox = findByLabel();
        if (!freshCheckbox) {
          await sleep(200);
          continue;
        }
        if (freshCheckbox.checked) {
          confirmedChecked = true;
          break;
        }
        freshCheckbox.scrollIntoView({ block: 'center' });
        await sleep(100);
        freshCheckbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        freshCheckbox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        freshCheckbox.click();
        freshCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);

        const afterClick = findByLabel();
        if (afterClick && afterClick.checked) {
          confirmedChecked = true;
          break;
        }
      }

      if (!confirmedChecked) {
        return { name, outcome: 'partial', detail: `Found "${targetLabel}", but it still isn't checked after ${MAX_ATTEMPTS} attempts.` };
      }

      return { name, outcome: 'success', detail: `Selected: ${targetLabel}` };
    }

    async function runSelection(names, logEl) {
      const results = [];
      for (const name of names) {
        logEl.textContent += `Searching: ${name}...\n`;
        const result = await selectStudent(name);
        results.push(result);
        const icon = { success: '✅', ambiguous: '⚠️', not_found: '❌', partial: '❓', error: '❌' }[result.outcome];
        logEl.textContent += `${icon} ${result.name}: ${result.detail}\n\n`;
        logEl.scrollTop = logEl.scrollHeight;
        await sleep(DELAY_BETWEEN_STUDENTS_MS);
      }
      const successCount = results.filter((r) => r.outcome === 'success').length;
      logEl.textContent += `\nDone: ${successCount}/${names.length} selected successfully.\n`;
      logEl.textContent += `Review the selected list in Grade Guardian, then click Send yourself when ready.\n`;
    }

    // Check for a pending handoff from Roll Call. We deliberately do NOT
    // clear this immediately — Grade Guardian appears to navigate through
    // one or more internal redirects after first loading (e.g. an auth or
    // loading URL before the real dashboard), and each of those wipes out
    // everything in memory, including any "keep the banner alive" logic.
    // Storage survives that; in-memory state doesn't. So instead we check
    // fresh on every load, and only clear the stored value once the person
    // actually acts (or it's old enough to be considered abandoned).
    const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
    const pendingRaw = GM_getValue(STORAGE_KEY, null);
    if (pendingRaw) {
      let pending;
      try {
        pending = JSON.parse(pendingRaw);
      } catch (e) {
        pending = null;
      }

      const isStale = pending && pending.createdAt && (Date.now() - pending.createdAt > STALE_AFTER_MS);
      if (isStale) {
        GM_setValue(STORAGE_KEY, null); // abandoned — don't haunt a future normal visit
      } else if (pending && pending.names && pending.names.length > 0) {
        const banner = document.createElement('div');
        Object.assign(banner.style, {
          position: 'fixed', top: '10px', right: '10px', zIndex: 100000,
          background: '#fff', border: '2px solid #7B1FA2', borderRadius: '8px',
          padding: '14px', width: '320px', fontFamily: 'sans-serif', fontSize: '13px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        });
        banner.innerHTML = `
          <div style="font-weight:bold;margin-bottom:8px;">Absent list from Roll Call (${pending.sourceDate})</div>
          <div style="margin-bottom:10px;">${pending.names.length} student(s): ${pending.names.join(', ')}</div>
          <button id="rcgg-start" style="padding:6px 12px;background:#7B1FA2;color:#fff;border:none;border-radius:4px;margin-right:6px;">Start Selecting</button>
          <button id="rcgg-dismiss" style="padding:6px 12px;">Dismiss</button>
          <div id="rcgg-log" style="margin-top:10px;font-size:12px;white-space:pre-wrap;max-height:300px;overflow-y:auto;"></div>
        `;
        document.body.appendChild(banner);

        // Best-effort: also try to keep it visible within THIS page load,
        // in case there's a same-page redraw rather than a full navigation.
        // If a full navigation happens instead, this loop dies with it —
        // but the script re-injects fresh on the new page and finds the
        // still-present stored value, showing the banner again from scratch.
        let bannerActive = true;
        const keepAliveInterval = setInterval(() => {
          if (!bannerActive) {
            clearInterval(keepAliveInterval);
            return;
          }
          if (!banner.isConnected) {
            document.body.appendChild(banner);
          }
        }, 300);

        banner.querySelector('#rcgg-dismiss').addEventListener('click', () => {
          bannerActive = false;
          GM_setValue(STORAGE_KEY, null);
          banner.remove();
        });
        banner.querySelector('#rcgg-start').addEventListener('click', async () => {
          bannerActive = false;
          GM_setValue(STORAGE_KEY, null);
          const startBtn = banner.querySelector('#rcgg-start');
          const logEl = banner.querySelector('#rcgg-log');
          startBtn.disabled = true;
          await runSelection(pending.names, logEl);
          startBtn.disabled = false;
        });
      }
    }
  }
})();
