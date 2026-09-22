[README.md](https://github.com/user-attachments/files/32520674/README.md)
# Odyssey Classroom Tools

A couple of small browser tools that save time on two repetitive tasks: taking attendance from Zoom, and adding notes to student records in Grade Guardian. You don't need to know anything technical to use these — just follow the steps below once, and after that it's just clicking a button whenever you need it.

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

- 📝 **[Grade Guardian Bulk Notes](LINK_HERE)** — add the same note to multiple students at once
- 📋 **[Zoom CSV to Roll Call](LINK_HERE)** — turn a Zoom attendance export into Roll Call attendance automatically

Once installed, you never have to think about them again — if either tool ever gets improved, your browser will quietly update it on its own.

---

## Using Grade Guardian Bulk Notes

1. Go to the student roster page in Grade Guardian, like you normally would.
2. Click the orange **"Bulk Add Note"** button in the top-right corner of the page.
3. A panel opens showing your students. Check the box next to everyone you want to add a note to.
   - You can page through the roster normally — new students you see get added to the list automatically, so you don't lose your place.
4. Type your note, and pick a tag from the dropdown (start typing to search, e.g. "SGP" or "Email").
5. Click **Submit All**. You'll see a ✅ or ❌ next to each student as it goes through.

Nothing is sent until you click that final button — so it's safe to open the panel, look around, and close it if you change your mind.

---

## Using Zoom CSV to Roll Call

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

## What these tools do NOT do

- **They don't email or message students.** Bulk Notes only writes into Grade Guardian's internal note log — nothing goes out to a student or guardian.
- **They don't touch grades.** Neither tool can see or change anything in the Canvas gradebook.
- **They don't submit anything automatically.** Every action — the note, the attendance — only goes through when you click the final "Submit" or "Apply" button. You can always close the panel first with no changes made.
- **They don't share your data with anyone else.** Everything runs locally in your own browser, talking directly to Grade Guardian, Roll Call, and Canvas the same way you would by clicking through the site yourself — nothing passes through us or any outside server.
- **They don't work on other schools' Grade Guardian or Roll Call setups.** These are built specifically for Odyssey's version of these tools.

---

## Something not working?

- **Don't see the button on the page?** Double check "Allow User Scripts" is turned on (see setup step 2 above).
- **Tampermonkey icon has a red badge?** Click it — it usually means it's asking permission to run, and you just need to approve it once.
- Still stuck? Reach out and we'll sort it out together.
