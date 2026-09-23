# Odyssey Classroom Tools

A couple of small browser tools that save time on two repetitive tasks: turning a Zoom attendance export into Roll Call attendance, and sending your absent list straight into Grade Guardian so you don't have to search for each student by hand. You don't need to know anything technical to use these — just follow the steps below once, and after that it's just clicking a button whenever you need it.

---

## One-time setup (takes about 2 minutes)

Before you can use either tool, your browser needs a free extension called **Tampermonkey**. Think of it like a helper that runs these little tools for you when you're on the right page.

1. **Install Tampermonkey** for your browser:
   - [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)

2. **Turn on "Allow User Scripts."** After installing, Chrome and Edge require one extra step:
   - Go to `chrome://extensions` (or `edge://extensions`)
   - Find Tampermonkey and click **Details**
   - Turn on **Allow User Scripts**

   *(If you skip this step, the tools just won't show up — if a button is missing later, this is the first thing to check.)*

That's it for setup. You only need to do this once.

---

## Installing the tools

Click each link below, then click **Install** on the page that opens:

- 📋 **[Zoom CSV to Roll Call](LINK_HERE)** — turn a Zoom attendance export into Roll Call attendance automatically
- 🔗 **[Roll Call to Grade Guardian Bridge](https://github.com/odysseyCTE-hub/Odyssey-Canvas-Tools/raw/refs/heads/main/rollcall-to-grade-guardian-bridge.user.js)** — send today's absent list from Roll Call straight into Grade Guardian, pre-selected

Once installed, you never have to think about them again — if either tool ever gets improved, your browser will quietly update it on its own.

---

## Using Zoom CSV to Roll Call

Do this one first — it's what marks your students Present/Late/Absent in Roll Call in the first place. The Grade Guardian bridge below reads that result, so it only makes sense to run after this step.

1. Download your attendance CSV from Zoom (Reports → Meetings → find your class → Export).
2. Open Roll Call for the section you want to update.
3. Click the green **"Import Zoom CSV"** button in the top-right corner.
4. Drag your CSV file into the box (or click to browse for it).
5. The first time you use it, type in your own name or email in the "host" field — this tells the tool to ignore you (the teacher) when it looks at who attended. It'll remember this for next time.
6. Click **Analyze CSV**. The tool will read the file and try to match each name to your Canvas roster.
7. **Check the matches.** Every student has a dropdown — most will already be correctly filled in, but a few uncertain ones will be flagged for you to double check.
8. Click **Continue to Preview** to see the final list before anything is submitted, including any students who didn't show up in the Zoom file at all (so you can decide if they should be marked absent).
9. Click **Apply** when it looks right.

### How Present / Late / Absent are decided
- **Present** — attended at least 31 minutes, *and* joined within 15 minutes of when class started
- **Late** — showed up, but either joined more than 15 minutes late, or didn't stay long enough for Present
- **Absent** — never actually got into the meeting

---

## Using the Roll Call to Grade Guardian Bridge

Run this one after Roll Call already has today's attendance in it (see above) — it reads whoever's currently marked Absent, so if you run it before importing attendance, there's nothing for it to send yet.

This one works in two steps, one on each site — but you only click one button on each side.

**Step 1 — on Roll Call:**
1. Open Roll Call and make sure it's showing the date you want (today, by default).
2. Click the purple **"Send Absent List → Grade Guardian"** button.
3. It reads whoever's currently marked Absent for that date and opens Grade Guardian in a new tab.

**Step 2 — on Grade Guardian:**
1. A small banner will appear automatically, showing exactly which students are about to be selected.
2. Click **"Start Selecting"** in that banner.
3. It searches for each student one at a time and checks their box, showing a ✅, ⚠️, ❌, or ❓ next to each name as it goes.
4. Once it's done, **you still click Send yourself** — this tool never sends anything on its own, it only gets the right students checked for you.

If a name comes back with a ⚠️ (multiple matches) or ❓ (couldn't confirm), just find and check that one student manually — everyone else will already be done.

---

## What these tools do NOT do

- **They don't email or message students.** Neither tool sends anything to a student or guardian.
- **They don't touch grades.** Neither tool can see or change anything in the Canvas gradebook.
- **They don't submit anything automatically.** The Zoom importer only applies attendance when you click "Apply." The Grade Guardian bridge only checks the right boxes for you — it never clicks Send. That's always your final click.
- **They don't share your data with anyone else.** Everything runs locally in your own browser, talking directly to Grade Guardian, Roll Call, and Canvas the same way you would by clicking through the site yourself — nothing passes through us or any outside server.
- **They don't work on other schools' Grade Guardian or Roll Call setups.** These are built specifically for Odyssey's version of these tools.

---

## Something not working?

- **Don't see the button on the page?** Double check "Allow User Scripts" is turned on (see setup step 2 above).
- **Tampermonkey icon has a red badge?** Click it — it usually means it's asking permission to run, and you just need to approve it once.
- Still stuck? Reach out and we'll sort it out together.
