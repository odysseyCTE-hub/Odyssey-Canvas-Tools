// ==UserScript==
// @name         Grade Guardian - Canvas API Sidebar Grades (Popup-Verified Total, Progressive Loading)
// @namespace    lisa-attendance-tool-gg-notes
// @version      10.11
// @description  Sidebar shows the EXACT Canvas "Total" for the current grading period by briefly opening each course's real Grades page (via the companion helper script) and reading the true rendered number. Table appears immediately with each row filling in live as its score arrives. Includes a "Retrieved from Canvas at..." timestamp and a manual refresh button. Requests enrollments with per_page=100 to avoid Canvas's default pagination hiding current courses behind older enrollment history. No longer pre-filters by Canvas enrollment state before matching. Fetches course names only for the small set of matched/final courses. Shows a brief on-screen "loaded" badge (bottom-left) and always logs real errors to console, so setup problems are diagnosable without needing DevTools for basic confirmation. Popup-opening code de-duplicated. Scoped to only the courses shown in Grade Guardian, in GG's order. Requires the companion "Grade Guardian - Canvas Grade Scraper Helper" script to also be installed/enabled.
// @match        https://prd-m.aspiredu.com/*
// @run-at       document-idle
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @connect      odysseyonlinelearning.instructure.com
// ==/UserScript==

(function () {
  'use strict';

  // Always logs, regardless of DEBUG — a quick way to confirm the script
  // actually loaded and is running, without needing to click anything first.
  console.log('GG Sidebar script v10.11 loaded and running.');

  // Visible on-screen confirmation, for anyone who'd rather glance at the
  // page than open DevTools. Small badge, bottom-left, fades away on its own.
  function showLoadedBadge() {
    const badge = document.createElement('div');
    badge.textContent = '✅ GG Sidebar script v10.11 loaded';
    Object.assign(badge.style, {
      position: 'fixed',
      bottom: '12px',
      left: '12px',
      backgroundColor: '#2e7d32',
      color: '#fff',
      padding: '6px 12px',
      borderRadius: '6px',
      fontSize: '12px',
      fontFamily: 'sans-serif',
      zIndex: '2147483647',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      transition: 'opacity 0.5s ease'
    });
    document.body.appendChild(badge);
    setTimeout(() => {
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 600);
    }, 4000);
  }

  if (document.body) {
    showLoadedBadge();
  } else {
    document.addEventListener('DOMContentLoaded', showLoadedBadge);
  }

  const CANVAS_BASE = 'https://odysseyonlinelearning.instructure.com';
  const DEBUG = false; // flip back to true if something needs troubleshooting

  function log(...args) {
    if (DEBUG) console.log('GG DEBUG —', ...args);
  }

  // Cache grading periods per course for the life of the page (they don't change minute to minute)
  const gradingPeriodCache = new Map(); // course_id -> array of periods

  // ---------------------------------------------------------------------
  // Student ID detection (unchanged from v6.6)
  // ---------------------------------------------------------------------
  function getActiveStudentId() {
    const navEl = document.querySelector('[x-data*="studentDetailNav"], [x-data*="lmsId"]');
    if (navEl && window.Alpine) {
      try {
        const alpineData = window.Alpine.$data(navEl);
        if (alpineData && alpineData.lmsId) {
          return String(alpineData.lmsId).trim();
        }
      } catch (e) {
        // fall through
      }
    }

    const canvasLinks = document.querySelectorAll('a[href*="instructure.com/users/"], a[href*="/courses/"][href*="/grades/"]');
    for (const link of canvasLinks) {
      const userMatch = link.href.match(/\/users\/([0-9]+)/);
      if (userMatch) return userMatch[1];
      const gradeMatch = link.href.match(/\/grades\/([0-9]+)/);
      if (gradeMatch) return gradeMatch[1];
    }

    const activePanel = document.querySelector('.modal.show, .student-profile-active, .tab-pane.active, #student-detail, .user-details, nav[aria-label*="Student"]');
    if (activePanel) {
      const lmsEl = activePanel.querySelector('[data-lms-id], [data-user-lms-id], [lms-id]');
      if (lmsEl) {
        const id = lmsEl.getAttribute('data-lms-id') || lmsEl.getAttribute('data-user-lms-id') || lmsEl.getAttribute('lms-id');
        if (id && /^\d+$/.test(id.trim())) return id.trim();
      }
    }

    const lmsAttrEl = document.querySelector('[data-lms-id]');
    if (lmsAttrEl) {
      const id = lmsAttrEl.getAttribute('data-lms-id');
      if (id && /^\d+$/.test(id.trim())) return id.trim();
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // Grade Guardian's own course list/order (unchanged from v6.6)
  // ---------------------------------------------------------------------
  function getGradeGuardianOrderedCourses() {
    const orderedList = [];
    const seenKeys = new Set();

    const selectors = 'a[href*="/courses/"], [data-course-id], .course-title, .course-name, td.course, tr.course-row';
    const elements = document.querySelectorAll(selectors);

    elements.forEach(el => {
      let id = null;
      if (el.href) {
        const match = el.href.match(/\/courses\/([0-9]+)/);
        if (match) id = match[1];
      }
      if (!id) {
        const dataId = el.getAttribute('data-course-id') || el.getAttribute('data-lms-course-id');
        if (dataId) id = dataId.trim();
      }

      const rawText = el.textContent.trim();
      const textLower = rawText.toLowerCase();

      if (textLower.includes('view') || textLower.includes('grade') || rawText.length < 3) return;

      const key = id || textLower;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        orderedList.push({ id: id, name: textLower });
      }
    });

    return orderedList;
  }

  // ---------------------------------------------------------------------
  // Network helpers
  // ---------------------------------------------------------------------
  function makeApiRequest(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          onload: (response) => {
            if (response.status === 200) {
              try { resolve(JSON.parse(response.responseText)); }
              catch (e) { reject(e); }
            } else {
              reject(response.status);
            }
          },
          onerror: (err) => reject(err)
        });
      } else {
        fetch(url, { credentials: 'include' })
          .then(res => res.json())
          .then(data => resolve(data))
          .catch(err => reject(err));
      }
    });
  }

  // ---------------------------------------------------------------------
  // Grading period resolution — always picks whichever period contains today
  // ---------------------------------------------------------------------
  async function getCurrentGradingPeriodId(courseId) {
    if (gradingPeriodCache.has(courseId)) {
      return gradingPeriodCache.get(courseId);
    }

    try {
      const url = `${CANVAS_BASE}/api/v1/courses/${courseId}/grading_periods`;
      const data = await makeApiRequest(url);
      const periods = (data && data.grading_periods) || [];
      log(`grading periods for course ${courseId}:`, periods);

      const now = new Date();
      let currentPeriod = periods.find(p => {
        const start = p.start_date ? new Date(p.start_date) : null;
        const end = p.end_date ? new Date(p.end_date) : null;
        return (!start || now >= start) && (!end || now <= end);
      });

      // Fallback: if nothing matches today exactly (e.g. gap between periods),
      // use whichever period Canvas flags as current.
      if (!currentPeriod) {
        currentPeriod = periods.find(p => p.is_current) || null;
      }

      const periodId = currentPeriod ? currentPeriod.id : null;
      gradingPeriodCache.set(courseId, periodId);
      return periodId;
    } catch (err) {
      log(`could not fetch grading periods for course ${courseId}, defaulting to null (all periods)`, err);
      gradingPeriodCache.set(courseId, null);
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Shared popup-opening helper — used by both the initial "View All Canvas
  // Grades" click and the refresh button. Must always be called synchronously
  // from within a real click handler, or the browser will block it.
  // ---------------------------------------------------------------------
  function openHelperPopup(studentId) {
    const win = window.open(
      'about:blank',
      'gg_canvas_helper_' + studentId,
      'width=200,height=150,left=-2000,top=-2000'
    );
    if (!win) {
      log('popup blocked by browser — cannot fetch verified totals this time');
    }
    return win;
  }

  // ---------------------------------------------------------------------
  // Popup-based scraping: opens ONE popup at click time (to satisfy popup
  // blockers, which require window.open to happen synchronously within a
  // real click), then reuses that same window for each course in sequence
  // by changing its location and waiting for the helper script's message.
  // ---------------------------------------------------------------------
  function fetchTotalViaPopup(courseId, studentId, periodId, helperWindow) {
    return new Promise((resolve) => {
      if (!helperWindow || helperWindow.closed) {
        log(`no usable popup window for course ${courseId} — resolving null`);
        resolve(null);
        return;
      }

      const reqId = `${courseId}_${Date.now()}`;
      const targetOrigin = CANVAS_BASE;
      let settled = false;

      function handleMessage(event) {
        if (event.origin !== targetOrigin) return;
        const data = event.data;
        if (!data || data.type !== 'gg_grade_result' || data.reqId !== reqId) return;
        settled = true;
        window.removeEventListener('message', handleMessage);
        clearTimeout(timeoutId);
        resolve(data.score !== null ? { score: data.score, letter: data.letter, raw: data.raw } : null);
      }

      window.addEventListener('message', handleMessage);

      const timeoutId = setTimeout(() => {
        if (settled) return;
        window.removeEventListener('message', handleMessage);
        log(`TIMEOUT waiting for popup result, course ${courseId}`);
        resolve(null);
      }, 12000);

      let url = `${CANVAS_BASE}/courses/${courseId}/grades/${studentId}?gg_auto=1&gg_reqid=${reqId}`;
      if (periodId) url += `&grading_period_id=${periodId}`;

      log(`navigating popup to:`, url);

      try {
        helperWindow.location.href = url;
      } catch (e) {
        clearTimeout(timeoutId);
        window.removeEventListener('message', handleMessage);
        log(`failed to navigate popup for course ${courseId}`, e);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Main fetch/render flow
  // ---------------------------------------------------------------------
  async function fetchStudentGrades(studentId, contentContainer, helperWindow) {
    contentContainer.innerHTML = `
      <div style="padding: 40px; text-align: center; color: #555; font-size: 16px;">
        <p>⏳ Fetching Canvas grades for Canvas User #${studentId}...</p>
      </div>
    `;

    const ggOrderedCourses = getGradeGuardianOrderedCourses();
    log('frame context — location:', window.location.href, ' is top frame:', window === window.top);
    log('GG scraped course list from DOM:', ggOrderedCourses);
    // Deliberately NOT filtering to state[]=active here. Grade Guardian is the
    // source of truth for which courses are relevant — pre-filtering by
    // Canvas's enrollment_state before matching could silently drop a course
    // GG considers current (e.g. an enrollment Canvas reports as "invited" or
    // some other non-"active" state) with no error shown, which is exactly
    // the bug we're fixing. We fetch everything and let the GG-match step
    // below decide what belongs.
    // per_page=100 is important here — Canvas's enrollments endpoint defaults
    // to a small page size (often 10) unless told otherwise. Since we removed
    // the state[]=active filter (to fix courses vanishing due to state
    // mismatches), a student with multiple years of history could have their
    // CURRENT courses pushed off the first page by older ones. Asking for a
    // much bigger page avoids that truncation.
    const apiUrl = `${CANVAS_BASE}/api/v1/users/${studentId}/enrollments?include[]=total_scores&include[]=course&per_page=100`;

    try {
      const enrollments = await makeApiRequest(apiUrl);
      const allEnrollments = enrollments || [];
      if (DEBUG) {
        log('all enrollments (unfiltered by state):', allEnrollments.map(e => ({ course_id: e.course_id, name: e.course && e.course.name, state: e.enrollment_state })));
      }

      if (!allEnrollments || allEnrollments.length === 0) {
        contentContainer.innerHTML = `<div style="padding: 30px; text-align: center; color: #666;">No course enrollments found in Canvas for User #${studentId}.</div>`;
        return;
      }

      // Just use whatever name Canvas's include[]=course already gave us —
      // no extra per-course API call. Matching happens primarily by course ID
      // (instant, no name needed), and name is only a fallback for that match,
      // so fetching a name for every one of a student's enrollments (which can
      // span several years of history) was mostly wasted network calls.
      const enrichedEnrollments = allEnrollments.map(e => ({
        ...e,
        displayName: (e.course && e.course.name) || (e.course_id ? `Course #${e.course_id}` : 'Course')
      }));

      // Match to ONLY the courses Grade Guardian actually shows, in GG's order.
      // If GG's own list is empty for some reason, fall back to showing everything
      // (matches prior behavior) rather than showing nothing.
      let finalCourseList = [];

      if (ggOrderedCourses.length > 0) {
        ggOrderedCourses.forEach(ggItem => {
          const match = enrichedEnrollments.find(e => {
            const courseIdStr = String(e.course_id);
            const courseNameLower = (e.displayName || '').toLowerCase();

            if (ggItem.id && ggItem.id === courseIdStr) return true;
            if (ggItem.name && (courseNameLower.includes(ggItem.name) || ggItem.name.includes(courseNameLower))) return true;

            return false;
          });

          if (match && !finalCourseList.includes(match)) {
            finalCourseList.push(match);
          } else if (!match && DEBUG) {
            // A course GG shows had NO matching Canvas enrollment at all —
            // worth knowing about explicitly rather than it just vanishing.
            log(`NO MATCH for GG course — id="${ggItem.id}" name="${ggItem.name}". Available enrollments:`,
              enrichedEnrollments.map(e => ({ course_id: e.course_id, name: e.displayName, state: e.enrollment_state })));
          }
        });
      }

      if (finalCourseList.length === 0) {
        finalCourseList = enrichedEnrollments;
      }

      // Backfill real names ONLY for the courses that actually made the final
      // list (a small set, typically 4-8) — not every enrollment Canvas
      // returned. Canvas's include[]=course doesn't always populate a name
      // (often true for older/concluded enrollments), so without this,
      // courses fall back to showing "Course #1234" instead of a real title.
      await Promise.all(
        finalCourseList.map(async (e) => {
          if (e.course && e.course.name) return; // already have a real name
          if (!e.course_id) return;
          try {
            const courseData = await makeApiRequest(`${CANVAS_BASE}/api/v1/courses/${e.course_id}`);
            if (courseData && courseData.name) {
              e.displayName = courseData.name;
            }
          } catch (err) {
            log(`could not backfill name for course ${e.course_id}`, err);
          }
        })
      );

      log('final course list (GG-scoped, GG-ordered):', finalCourseList.map(e => e.displayName));

      // Render the table shell IMMEDIATELY with a loading state per row, so
      // the sidebar doesn't sit blank while we work through each course.
      renderSkeletonTable(finalCourseList, studentId, contentContainer);

      // Now fill in each row's REAL total as soon as it comes back — one
      // course at a time (reusing the same popup window), updating that
      // row live rather than waiting for everything to finish.
      for (const e of finalCourseList) {
        const periodId = await getCurrentGradingPeriodId(e.course_id);
        const result = await fetchTotalViaPopup(e.course_id, studentId, periodId, helperWindow);
        updateRowScore(e.course_id, result);
      }

      if (helperWindow && !helperWindow.closed) {
        helperWindow.close();
      }

      const stamp = document.getElementById('gg-retrieved-at');
      if (stamp) {
        stamp.textContent = `Retrieved from Canvas at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
      }
    } catch (err) {
      // Always log this, regardless of the DEBUG flag — a total failure like
      // this needs to be diagnosable without asking someone to flip a setting
      // first. This is the actual reason nothing loaded.
      console.error('GG ERROR — fetchStudentGrades failed:', err);
      renderError(contentContainer, err, studentId);
    }
  }

  function rowIdFor(courseId) {
    return `gg-score-cell-${courseId}`;
  }

  function renderSkeletonTable(enrollments, studentId, container) {
    if (!enrollments || enrollments.length === 0) {
      container.innerHTML = `<div style="padding: 30px; text-align: center; color: #666;">No matching courses found on Grade Guardian page.</div>`;
      return;
    }

    let rowsHtml = enrollments.map(e => {
      const courseName = e.displayName;
      return `
        <tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 12px; font-weight: 500; color: #333; line-height: 1.3;">${courseName}</td>
          <td id="${rowIdFor(e.course_id)}" style="padding: 12px; text-align: right; font-weight: bold; color: #29847E; white-space: nowrap;">
            <span style="color:#bbb; font-size: 12px; font-weight: normal;">⏳ Loading…</span>
          </td>
          <td style="padding: 12px; text-align: center; white-space: nowrap;">
            <a href="${CANVAS_BASE}/courses/${e.course_id}/grades/${studentId}" target="_blank" style="color: #007bff; text-decoration: none;">View ↗</a>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div style="padding: 15px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; text-align: left;">
          <thead>
            <tr style="background-color: #f8f9fa; border-bottom: 2px solid #dee2e6;">
              <th style="padding: 12px;">Course Name</th>
              <th style="padding: 12px; text-align: right;">Grade</th>
              <th style="padding: 12px; text-align: center;">Assignments</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <div id="gg-retrieved-at" style="padding: 8px 12px; font-size: 11px; color: #999;">Retrieving from Canvas…</div>
      </div>
    `;
  }

  function updateRowScore(courseId, result) {
    const cell = document.getElementById(rowIdFor(courseId));
    if (!cell) return; // sidebar may have been closed/switched mid-fetch

    if (result && result.score !== null && !isNaN(result.score)) {
      const letter = result.letter ? ` (${result.letter})` : '';
      cell.innerHTML = `${result.score}%${letter}`;
    } else {
      cell.innerHTML = `<span style="color:#999; font-size: 12px; font-weight: normal;">Unable to load — click View</span>`;
    }
  }

  function renderError(container, err, studentId) {
    const fullUrl = `${CANVAS_BASE}/users/${studentId}/grades`;
    container.innerHTML = `
      <div style="padding: 30px; text-align: center; color: #d9534f;">
        <h4>Unable to auto-load grades table</h4>
        <p style="color: #666; font-size: 13px;">Please ensure you are logged into Canvas in this browser.</p>
        <a href="${fullUrl}" target="_blank" style="display: inline-block; margin-top: 15px; padding: 10px 18px; background-color: #29847E; color: #fff; border-radius: 4px; text-decoration: none; font-weight: bold;">Open Full Canvas Grades Page ↗</a>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Sidebar UI plumbing (unchanged from v6.6)
  // ---------------------------------------------------------------------
  function toggleCanvasSidebar(studentId, helperWindow) {
    let sidebar = document.getElementById('gg-canvas-sidebar');

    if (sidebar) {
      if (sidebar.getAttribute('data-student-id') === studentId) {
        // Already loaded for this student — just toggling visibility, no
        // fetch needed, so close the popup we just opened for nothing.
        if (helperWindow && !helperWindow.closed) helperWindow.close();
        const isOpen = sidebar.style.right === '0px';
        sidebar.style.right = isOpen ? '-500px' : '0px';
        return;
      } else {
        sidebar.remove();
      }
    }

    sidebar = document.createElement('div');
    sidebar.id = 'gg-canvas-sidebar';
    sidebar.setAttribute('data-student-id', studentId);

    Object.assign(sidebar.style, {
      position: 'fixed',
      top: '0',
      right: '-500px',
      width: '480px',
      height: '100vh',
      backgroundColor: '#ffffff',
      boxShadow: '-4px 0 20px rgba(0,0,0,0.25)',
      zIndex: '999999',
      transition: 'right 0.3s ease-in-out',
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '3px solid #29847E'
    });

    sidebar.innerHTML = `
      <div style="background-color: #29847E; color: #fff; padding: 14px 18px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 15px;">📊 Canvas Course Grades</span>
        <span style="display: flex; align-items: center; gap: 14px;">
          <button id="gg-refresh-btn" title="Refresh grades" style="background: transparent; border: none; color: #fff; font-size: 17px; cursor: pointer; line-height: 1;">↻</button>
          <button id="gg-close-sidebar-btn" style="background: transparent; border: none; color: #fff; font-size: 20px; cursor: pointer; font-weight: bold; line-height: 1;">✕</button>
        </span>
      </div>
      <div id="gg-sidebar-content" style="flex: 1; overflow-y: auto;"></div>
    `;

    document.body.appendChild(sidebar);

    setTimeout(() => { sidebar.style.right = '0px'; }, 10);

    document.getElementById('gg-close-sidebar-btn').addEventListener('click', () => {
      sidebar.style.right = '-500px';
    });

    document.getElementById('gg-refresh-btn').addEventListener('click', function () {
      const refreshWindow = openHelperPopup(studentId);

      const btn = this;
      btn.style.transition = 'transform 0.6s linear';
      btn.style.transform = 'rotate(360deg)';
      setTimeout(() => { btn.style.transition = 'none'; btn.style.transform = 'rotate(0deg)'; }, 600);

      const contentBox = sidebar.querySelector('#gg-sidebar-content');
      fetchStudentGrades(studentId, contentBox, refreshWindow);
    });

    const contentBox = sidebar.querySelector('#gg-sidebar-content');
    fetchStudentGrades(studentId, contentBox, helperWindow);
  }

  function syncCanvasGradesTab() {
    const navTabs = document.querySelector('ul.nav-tabs, .nav-pills, .tab-container, .nav');
    if (!navTabs) return;

    const studentId = getActiveStudentId();
    const existingTab = document.getElementById('gg-all-canvas-grades-tab');

    if (!studentId) {
      if (existingTab) existingTab.remove();
      const existingSidebar = document.getElementById('gg-canvas-sidebar');
      if (existingSidebar) existingSidebar.remove();
      return;
    }

    if (existingTab && existingTab.getAttribute('data-student-id') === studentId) {
      return;
    }

    if (existingTab) {
      existingTab.remove();
    }

    const tabLi = document.createElement('li');
    tabLi.id = 'gg-all-canvas-grades-tab';
    tabLi.className = 'nav-item';
    tabLi.setAttribute('data-student-id', studentId);

    const tabAnchor = document.createElement('a');
    tabAnchor.className = 'nav-link';
    tabAnchor.href = '#';
    tabAnchor.innerHTML = `📊 View All Canvas Grades`;

    Object.assign(tabAnchor.style, {
      fontWeight: 'bold',
      color: '#29847E',
      cursor: 'pointer'
    });

    tabAnchor.addEventListener('click', (e) => {
      e.preventDefault();
      const helperWindow = openHelperPopup(studentId);
      toggleCanvasSidebar(studentId, helperWindow);
    });

    tabLi.appendChild(tabAnchor);
    navTabs.appendChild(tabLi);
  }

  const observer = new MutationObserver(syncCanvasGradesTab);
  observer.observe(document.body, { childList: true, subtree: true });

  syncCanvasGradesTab();
})();
