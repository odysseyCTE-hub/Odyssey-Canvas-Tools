// ==UserScript==
// @name         Canvas Gradebook - Clear Locked Missing Tags
// @namespace    odyssey-tools
// @version      3.3
// @description  Clears "Missing" tags for assignments due 14+ days prior to a chosen date (defaults to today). Leaves grades untouched.
// @match        https://odysseyonlinelearning.instructure.com/courses/*/gradebook*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = window.location.origin;
  const COURSE_ID = window.location.pathname.match(/\/courses\/(\d+)/)?.[1];
  if (!COURSE_ID) return;

  const LOCK_WINDOW_DAYS = 14;

  // ---------- Helpers ----------

  function getCsrfToken() {
    const match = document.cookie.match(/_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchAllPages(url) {
    let results = [];
    let nextUrl = url;
    while (nextUrl) {
      const res = await fetch(nextUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Request failed (${res.status}): ${nextUrl}`);
      const data = await res.json();
      results = results.concat(data);

      const linkHeader = res.headers.get('Link');
      nextUrl = null;
      if (linkHeader) {
        const links = linkHeader.split(',');
        for (const link of links) {
          const [urlPart, relPart] = link.split(';');
          if (relPart && relPart.includes('rel="next"')) {
            nextUrl = urlPart.trim().replace(/^<|>$/g, '');
          }
        }
      }
    }
    return results;
  }

  function isMissing(submission) {
    return submission.late_policy_status === 'missing' || (submission.missing === true && !submission.late_policy_status);
  }

  async function clearMissingTag(assignmentId, userId) {
    const csrf = getCsrfToken();
    const url = `${API_BASE}/api/v1/courses/${COURSE_ID}/assignments/${assignmentId}/submissions/${userId}`;
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({ submission: { late_policy_status: 'none' } }),
    });
    if (!res.ok) {
      throw new Error(`Failed to update assignment ${assignmentId}, user ${userId} (${res.status})`);
    }
  }

  // ---------- Core Logic ----------

  async function run(cutoffDate, logFn) {
    logFn(`Fetching assignments...`);
    logFn(`Targeting locked assignments due on or before: ${cutoffDate.toLocaleDateString()}`);

    const assignments = await fetchAllPages(
      `${API_BASE}/api/v1/courses/${COURSE_ID}/assignments?per_page=100`
    );

    let updatedCount = 0;

    for (const assignment of assignments) {
      let submissions;
      try {
        submissions = await fetchAllPages(
          `${API_BASE}/api/v1/courses/${COURSE_ID}/assignments/${assignment.id}/submissions?per_page=100`
        );
      } catch (err) {
        logFn(`⚠ "${assignment.name}": could not fetch submissions — ${err.message}`);
        continue;
      }

      let assignmentLogged = false;

      for (const sub of submissions) {
        const effectiveDueRaw = sub.cached_due_date || assignment.due_at;
        if (!effectiveDueRaw) continue;

        const dueDate = new Date(effectiveDueRaw);

        // Skip assignments due after the cutoff date
        if (dueDate > cutoffDate) continue;

        // Skip if not tagged as missing
        if (!isMissing(sub)) continue;

        if (!assignmentLogged) {
          logFn(`Checking "${assignment.name}"...`);
          assignmentLogged = true;
        }

        try {
          await clearMissingTag(assignment.id, sub.user_id);
          updatedCount++;
          logFn(`  ✓ Cleared Missing tag — user ${sub.user_id} (due ${dueDate.toLocaleDateString()})`);
        } catch (err) {
          logFn(`  ⚠ ${err.message}`);
        }

        await sleep(150); // Rate limiting protection
      }
    }

    logFn(`\nFinished! Cleared Missing tags for ${updatedCount} locked submission(s).`);
  }

  // ---------- UI ----------

  function injectButton() {
    const btn = document.createElement('button');
    btn.textContent = '🧹 Clear Locked Missing Tags';
    btn.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 9999;
      padding: 10px 16px; background: #1A7A7A; color: #fff; border: none;
      border-radius: 6px; cursor: pointer; font-family: Lato, sans-serif;
      font-size: 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.25);
    `;
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  function openModal() {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000;
      display: flex; align-items: center; justify-content: center;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: #fff; border-radius: 8px; padding: 20px; width: 360px;
      font-family: Lato, sans-serif; max-height: 80vh; overflow-y: auto;
    `;

    box.innerHTML = `
      <h3 style="margin-top:0;color:#1A7A7A;">Clear Locked Missing Tags</h3>
      <p style="font-size:13px;color:#555;">
        Clears the "Missing" tag for all submissions on assignments due <strong>14+ days prior</strong> to the selected date.
      </p>
      
      <label style="display:block;margin-top:10px;font-size:13px;font-weight:bold;">Run as of date:</label>
      <input type="date" id="cmt-asof" style="width:100%;padding:6px;margin-top:4px;box-sizing:border-box;">
      <div id="cmt-computed" style="font-size:12px;color:#555;margin-top:6px;font-style:italic;"></div>

      <div id="cmt-btn-row" style="margin-top:16px;display:flex;gap:8px;">
        <button id="cmt-run" style="flex:1;padding:8px;background:#663399;color:#fff;border:none;border-radius:4px;cursor:pointer;">Run Now</button>
        <button id="cmt-cancel" style="flex:1;padding:8px;background:#eee;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
      </div>
      <pre id="cmt-log" style="margin-top:12px;font-size:11px;background:#f7f7f7;padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;white-space:pre-wrap;"></pre>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const asOfInput = document.getElementById('cmt-asof');
    const computedEl = document.getElementById('cmt-computed');

    // Default input to today's date
    const today = new Date();
    asOfInput.value = today.toISOString().slice(0, 10);

    function updateComputedCutoff() {
      if (!asOfInput.value) {
        computedEl.textContent = '';
        return;
      }
      const asOf = new Date(asOfInput.value + 'T23:59:59');
      const cutoff = new Date(asOf);
      cutoff.setDate(cutoff.getDate() - LOCK_WINDOW_DAYS);

      computedEl.textContent = `→ Clears tags on assignments due on or before: ${cutoff.toLocaleDateString()}`;
    }

    asOfInput.addEventListener('change', updateComputedCutoff);
    updateComputedCutoff();

    let runCompleted = false;

    const closeAndMaybeRefresh = () => {
      overlay.remove();
      if (runCompleted) window.location.reload();
    };

    document.getElementById('cmt-cancel').addEventListener('click', closeAndMaybeRefresh);

    document.getElementById('cmt-run').addEventListener('click', async () => {
      const logEl = document.getElementById('cmt-log');
      const runBtn = document.getElementById('cmt-run');
      const cancelBtn = document.getElementById('cmt-cancel');
      const btnRow = document.getElementById('cmt-btn-row');

      if (!asOfInput.value) {
        alert('Please select an "as of" date.');
        return;
      }

      const asOf = new Date(asOfInput.value + 'T23:59:59');
      const cutoffDate = new Date(asOf);
      cutoffDate.setDate(cutoffDate.getDate() - LOCK_WINDOW_DAYS);

      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
      cancelBtn.disabled = true;
      logEl.textContent = '';

      const log = (msg) => {
        logEl.textContent += msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
      };

      try {
        await run(cutoffDate, log);
      } catch (err) {
        log(`⚠ Fatal error: ${err.message}`);
      } finally {
        runCompleted = true;
        btnRow.innerHTML = '';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close & Refresh Gradebook';
        closeBtn.style.cssText = 'flex:1;padding:8px;background:#1A7A7A;color:#fff;border:none;border-radius:4px;cursor:pointer;';
        closeBtn.addEventListener('click', closeAndMaybeRefresh);
        btnRow.appendChild(closeBtn);
      }
    });
  }

  injectButton();
})();