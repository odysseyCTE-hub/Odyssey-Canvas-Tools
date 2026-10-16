// ==UserScript==
// @name         Grade Guardian - Canvas Grade Scraper Helper
// @namespace    lisa-attendance-tool-gg-notes
// @version      1.6
// @description  Runs on the real Canvas grades page when opened by the sidebar automation (as a popup OR inside a hidden iframe); waits for the real rendered "Total", then polls for status pills to actually finish populating (instead of a fixed wait) before counting missing assignments — finishes as soon as real pill content appears, capped at the same 900ms ceiling as before for slow/empty cases. Sends both back via postMessage.
// @updateURL    https://raw.githubusercontent.com/odysseyCTE-hub/Odyssey-Canvas-Tools/main/Grade%20Guardian%20-%20Canvas%20Grade%20Scraper%20Helper-1.1.user.js
// @downloadURL  https://raw.githubusercontent.com/odysseyCTE-hub/Odyssey-Canvas-Tools/main/Grade%20Guardian%20-%20Canvas%20Grade%20Scraper%20Helper-1.1.user.js
// @match        https://odysseyonlinelearning.instructure.com/courses/*/grades/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);

  // Only act when this page was opened BY our automation — never interferes
  // with a normal manual visit to a grades page.
  if (params.get('gg_auto') !== '1') return;

  const reqId = params.get('gg_reqid');
  const TARGET_ORIGIN = 'https://prd-m.aspiredu.com';

  function extractMissingCount() {
    // Primary strategy: Canvas renders a status "pill" (a small colored badge,
    // e.g. "Missing", "Late", "Excused") inside a dedicated element per
    // assignment row — more precise and robust than scanning free text.
    const pillContainers = document.querySelectorAll('#grades_summary .react_pill_container');
    let count = 0;
    let foundAnyPill = false;

    pillContainers.forEach(container => {
      const text = container.textContent.trim();
      if (text) foundAnyPill = true;
      if (/missing/i.test(text)) count++;
    });

    if (foundAnyPill) return count;

    // Fallback: if no pills were found at all (e.g. Canvas changes this
    // structure, or this course renders status differently), fall back to
    // checking each row's status cell text directly.
    const rows = document.querySelectorAll('#grades_summary tr.student_assignment');
    let fallbackCount = 0;
    rows.forEach(row => {
      const statusCell = row.querySelector('td.status');
      if (statusCell && /missing/i.test(statusCell.textContent)) {
        fallbackCount++;
      }
    });
    return fallbackCount;
  }

  function extractTotalOnly() {
    // A few known selectors for the real, rendered Total row (confirmed via
    // Inspect Element + the grades page's own stylesheet).
    const selectors = [
      'tr.final_grade .grade',
      '.student_assignment.final_grade .grade',
      '#submission_final-grade .grade'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        const text = el.textContent.trim();
        const match = text.match(/([\d.]+)\s*%/);
        if (match) {
          let letter = null;
          const row = el.closest('tr, div.student_assignment');
          if (row) {
            const letterEl = row.querySelector('.letter_grade');
            if (letterEl) letter = letterEl.textContent.replace(/[()]/g, '').trim();
          }
          return { score: parseFloat(match[1]), letter, raw: text };
        }
      }
    }
    return null;
  }

  function sendResult(result) {
    const message = {
      type: 'gg_grade_result',
      reqId: reqId,
      score: result ? result.score : null,
      letter: result ? result.letter : null,
      raw: result ? result.raw : null,
      missingCount: result ? result.missingCount : null
    };

    // Support both delivery methods: opened as a popup (window.opener) or
    // embedded in a hidden iframe (window.parent). Try whichever applies.
    if (window.opener) {
      window.opener.postMessage(message, TARGET_ORIGIN);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, TARGET_ORIGIN);
    }
  }

  function anyPillHasContent() {
    const containers = document.querySelectorAll('#grades_summary .react_pill_container');
    for (const c of containers) {
      if (c.textContent.trim()) return true;
    }
    return false;
  }

  // Once the Total appears, status pills ("Missing", "Late", etc.) haven't
  // necessarily finished populating yet. Rather than always waiting a fixed
  // 900ms no matter what, poll for the first sign a pill has real content,
  // then take one more short beat for the rest to settle, and finish right
  // then — this can only finish AT or BEFORE the old fixed delay, never
  // later, since 900ms still acts as a hard ceiling for slow/empty cases.
  function waitForPillsThenSend(totalResult) {
    const ceilingMs = 900;
    const pollEveryMs = 100;
    const settleAfterFirstSignMs = 150;

    const startedAt = Date.now();
    let sent = false;
    let settleTimer = null;

    function finish() {
      if (sent) return;
      sent = true;
      clearInterval(pillPoll);
      if (settleTimer) clearTimeout(settleTimer);
      const missingCount = extractMissingCount();
      console.log('GG Helper — missing count detected:', missingCount, 'on', window.location.href);
      sendResult({ ...totalResult, missingCount });
    }

    const pillPoll = setInterval(() => {
      if (!settleTimer && anyPillHasContent()) {
        // First sign pills are populating — give a short settle window for
        // the rest, then finish (instead of always waiting the full ceiling).
        settleTimer = setTimeout(finish, settleAfterFirstSignMs);
      }
      if (Date.now() - startedAt >= ceilingMs) {
        finish(); // ceiling reached — finish now regardless (same as the old fixed wait)
      }
    }, pollEveryMs);
  }

  let attempts = 0;
  const maxAttempts = 60; // ~12 seconds at 200ms polling — generous for a real page load
  const interval = setInterval(() => {
    attempts++;
    const totalResult = extractTotalOnly();
    if (totalResult) {
      clearInterval(interval);
      waitForPillsThenSend(totalResult);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      sendResult(null); // let the sidebar know this one failed/timed out rather than hang forever
    }
  }, 200);
})();
