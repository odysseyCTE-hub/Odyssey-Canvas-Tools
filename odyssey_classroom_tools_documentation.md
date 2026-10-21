# Odyssey Classroom Tools

A collection of lightweight browser tools designed to streamline repetitive tasks for teachers: importing Zoom attendance into Roll Call, syncing absent lists to Grade Guardian, sending bulk notes, and viewing up-to-date student grades. You don't need technical knowledge to use these — follow the one-time setup below, and then it's just a matter of clicking a button when needed.

## One-Time Setup (takes about 2 minutes)

Before using any of these tools, your browser needs a free extension called **Tampermonkey** to run the scripts.

1. **Install Tampermonkey** for your browser:

   * [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)

2. **Turn on "Allow User Scripts"** (Chrome and Edge users):

   * Go to `chrome://extensions` (or `edge://extensions`)
   * Find Tampermonkey and click **Details**
   * Toggle on **Allow User Scripts**

   *(If skipped, the script buttons will not appear on the pages.)*

## Installing the Tools

Click each link below and select **Install** on the page that opens:

* 📋 [**Zoom CSV to Roll Call**](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/zoom-csv-to-rollcall.user.js) — Automatically imports Zoom attendance exports into Canvas Roll Call.

* 🔗 [**Roll Call to Grade Guardian Bridge**](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/rollcall-to-grade-guardian-bridge.user.js) — Sends the list of absent students from Roll Call straight into Grade Guardian with pre-selected checkboxes.

* 📝 [**Grade Guardian Bulk Note**](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/Grade%20Guardian%20Bulk%20Notes-Green.user.js) — Allows selecting multiple students in Grade Guardian to submit a mass note simultaneously.

* 📚 [**View All Grades Sidebar**](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/Grade%20Guardian%20-%20Canvas%20API%20Sidebar%20Grades.user.js) — Adds a quick sidebar tab in Grade Guardian to view current Canvas grades for students.

  * 🪛 [**View All Grades Scraper Helper**](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/Grade%20Guardian%20-%20Canvas%20Grade%20Scraper%20Helper-1.1.user.js) — Background helper script required for the View All Grades Sidebar to fetch grade data.

## How to Use the Tools

### 📋 1. Zoom CSV to Roll Call

1. Export the attendance CSV from Zoom (**Reports** → **Meetings** → select meeting → **Export**). Do not click “unique users”.
2. Open Canvas Roll Call for your target section.
3. Click the green **"Import Zoom CSV"** button in the top-right corner.
4. Drag and drop your downloaded CSV into the window (or click to browse).
5. Enter your name or email in the "host" field during **first-time setup** so the tool filters out the instructor from attendance.
6. Click **Analyze CSV**. Review the matched students and resolve any flagged entries.
7. Click **Continue to Preview** to double-check student statuses.
8. Click **Apply** to save attendance.

  **Attendance Rules:**
  * **Present:** Attended $\ge 31$ minutes and joined within the first 15 minutes.
  * **Late:** Attended, but joined after 15 minutes or stayed less than 31 minutes.
  * **Absent:** Did not enter the meeting.

### 🔗 2. Roll Call to Grade Guardian Bridge

1. Open Roll Call to today's date (or the date you wish to log).
2. Click the purple **"Send Absent List → Grade Guardian"** button.
3. Grade Guardian will open automatically in a new browser tab with a confirmation banner.
4. Click **"Start Selecting"** in the banner.
5. The tool will auto-check boxes for absent students (marked with ✅). Review any items marked with ⚠️ or ❓ manually.
6. Click "Send Message” to send a message to all selected students. 
7. Review the form and click **Send** when ready.

### 📝 3. Grade Guardian Bulk Note

1. Navigate to Grade Guardian.
2. Click the teal Bulk Add Note at the top right.
3. Select multiple students using the bulk selection checkboxes. *To have entire course roster appear, scroll through pages at the bottom of the Grade Guardian screen.*
4. Enter your note text into the mass note input box.
5. Select the appropriate Grade Guardian tag.
6. Submit the note to apply it across all selected student profiles at once.

### 📚 4. View All Grades Sidebar

1. Ensure both the **Sidebar** script and the **Scraper Helper** script are installed.
2. Open Grade Guardian to an individual student record page.
3. Click the **View All Grades** next to Attendance within the student record. 
4. A sidebar will appear on the right edge of the screen to load current student grades and missing assignments for all classes (must allow pop-ups). 

## Important Security & Privacy Notes

* **No automated submissions:** The scripts do not automatically send messages, contact guardians, or alter Canvas gradebook entries without your final click.
* **Local processing:** All data processing occurs locally within your web browser session. No data is transmitted to external third-party servers.
* **Scope:** These tools are tailored specifically for Odyssey's Canvas and Grade Guardian configuration.

## Troubleshooting

* **Buttons missing?** Re-check that **Allow User Scripts** is enabled under Tampermonkey extension settings.
* **Tampermonkey badge notification?** Click the Tampermonkey icon in your browser toolbar to approve any pending domain permission requests.
