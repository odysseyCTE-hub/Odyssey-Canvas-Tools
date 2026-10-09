// ==UserScript==
// @name         Grade Guardian - Canvas Grade Scraper Helper
// @namespace    lisa-attendance-tool-gg-notes
// @version      1.1
// @description  Runs on the real Canvas grades page when opened by the sidebar automation (as a popup OR inside a hidden iframe); waits for the real rendered "Total" and sends it back via postMessage.
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

  function extractTotal() {
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
      raw: result ? result.raw : null
    };

    // Support both delivery methods: opened as a popup (window.opener) or
    // embedded in a hidden iframe (window.parent). Try whichever applies.
    if (window.opener) {
      window.opener.postMessage(message, TARGET_ORIGIN);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, TARGET_ORIGIN);
    }
  }

  let attempts = 0;
  const maxAttempts = 60; // ~12 seconds at 200ms polling — generous for a real page load
  const interval = setInterval(() => {
    attempts++;
    const result = extractTotal();
    if (result) {
      clearInterval(interval);
      sendResult(result);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      sendResult(null); // let the sidebar know this one failed/timed out rather than hang forever
    }
  }, 200);
})();
