# Setting up @me

This guide has two parts. **Using @me** is for anyone who wants to install it, and takes about five minutes. **For the developer** is the one-time Google setup that makes Google Calendar sign-in work for everyone.

# Using @me

## 1. Install it (2 minutes)

1. Click **Download @me** at [atme.tech](https://atme.tech/#install), or download `atme-extension.zip` from the repo's [latest release](../../../releases/latest).
2. Unzip it. You'll get a folder called `atme-extension`. Put it somewhere it can stay, like your Documents folder.
3. Open `chrome://extensions` in **Google Chrome** and turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `atme-extension` folder.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **@me**. Click it, then **Open @me**.

That's it. @me works right away with pasted syllabi, Word files, and the built-in quiz questions. The steps below add more.

Downloaded the whole repo instead? Choose its `extension` folder in step 4.

## 2. Add a free Gemini key (optional, recommended)

With a key, @me can read PDFs and screenshots, write quizzes from your slides, grade your free-response answers, and understand anything you type.

1. Go to Google AI Studio and click **Get API key**, then **Create API key**. No credit card needed.
2. In @me, open **⚙ Settings**, paste the key under **Gemini API key**, and click **Test connection**.

The free tier has daily limits, and Google's terms let it use free-tier requests to improve its products. If you hit the limit, @me switches to its built-in features until it resets. Your key stays in Chrome on your computer and is only sent to Google.

## 3. Connect Google Calendar

Click **Connect Google** in @me's top bar and sign in.

- If you see **"Access blocked,"** @me's Google sign-in is still in testing mode, and your account isn't on its tester list yet. Ask the developer to add your Google account.
- If you see **"Google hasn't verified this app,"** click **Advanced**, then **Go to @me**. That's normal until Google finishes reviewing @me.

Google sign-in only works in Google Chrome, not in Edge, Brave, or other Chromium browsers.

## 4. Connect Canvas (optional)

1. In Canvas: **Account → Settings → New Access Token**. Give it an expiration date.
2. In @me Settings, enter your Canvas address (like `canvas.yourschool.edu`) and the token.
3. Click **Connect Canvas**. Chrome will ask permission for @me to reach that one site.

If your school doesn't allow student tokens, import syllabi instead.

## Using it

Type **/help** in the chat anytime to see everything @me can do, with examples you can tap. Typing **/** shows shortcuts like `/plan`, `/practice midterm`, `/briefing`, `/notes`, and `/undo`.

1. Open the dashboard (the toolbar popup's **Open @me** button, or it opens on install).
2. Add classes: **Import a syllabus** (upload a PDF or Word file, or paste the text), or **Import from Canvas**. Pasting a whole syllabus into the chat box works too.
3. Answer the setup questions, then let @me plan.
4. Sessions appear on a new **@me Study** calendar in Google Calendar. @me also offers to put your class times on **@me Classes** and your exams, quizzes, and assignments on **@me Deadlines** (or turn those on under Study settings in the sidebar). Study sessions appear with a reminder 10 minutes before each one. Every change, including undo, syncs automatically.
5. Add your slides, notes, or an old exam with **📎 Slides & notes** under each class, so quizzes and practice exams come from your actual course.
   Before an exam, say "review for my midterm" or click **✏️ Practice** next to it in Upcoming. Pick topics and 5, 10, or 15 questions, from your notes and slides or just from the topics.
6. When a session starts, focus mode blocks YouTube, Instagram, TikTok, and Reddit until the timer ends. Then you get a quick quiz and a check-in.

The red ❗ shows up on the toolbar icon and the @me launcher whenever @me changes your calendar on its own: a surprise quiz you added, or a new quiz or exam it found on Canvas.

## Updating @me

Download the newest release, unzip it, and replace **everything** in your `atme-extension` folder with the new files. Then click the reload arrow on @me at `chrome://extensions`. Your classes and plan stay, because @me keeps the same ID in every version.

Replace the whole folder, not just some files. Mixing versions can stop @me from starting. If that happens, it shows a message listing what's missing.

## If Chrome crashes

A web page or extension can't normally crash all of Chrome, so first turn @me off at `chrome://extensions`, fully quit Chrome, and reopen it. If it still crashes, the cause is elsewhere (try updating Chrome under Settings → About Chrome). `chrome://crashes` lists recent crashes.

If @me doesn't finish starting twice in a row, it opens in **safe mode**: Google, Canvas, focus mode, and background checks pause until you click **Turn safe mode off**. You can also open safe mode on purpose by adding `?safe=1` to the dashboard address.

## If @me can't fit study sessions

@me now explains why and offers a one-click fix. The usual causes:

- **A long event on your Google Calendar,** like "Fall semester" entered as a timed event all day. Events 12 hours or longer no longer block time; they show at the top of the day instead.
- **A repeating event you don't study around,** like a shift. Use the × on that block and choose **Ignore every "…" event**.
- **An old syllabus that kept last year's dates.** @me offers to move it to this semester on the same weekdays.
- **A class set to "None" study time,** or items marked "no prep."
- **Nothing due soon.** @me now plans ahead to your next deadline, up to 10 weeks out.

## Known limits

- Reading syllabi and schedule screenshots needs a Gemini key. Word files are converted to text in your browser first. Pasted text and Word files also work without any AI key, using a simpler built-in reader. Older .doc files need to be saved as .docx or PDF. If a syllabus is from a past semester, @me offers to move it to this one on the same weekdays and marks those dates "Estimated" until you get the real syllabus.
- Canvas usually doesn't know when classes meet. @me checks the Canvas calendar and each course's syllabus page, and for anything still missing, use **📋 Import my whole class schedule** in the sidebar (paste it or upload a screenshot), the **＋ Add class times** form, or chat, like "CALC 151 meets Tue/Thu 8:40-10am".
- Canvas is checked every 30 minutes, since it doesn't push updates to student apps. Use **Check Canvas now** in the popup for an instant check.
- Study sessions are planned Monday to Friday unless you turn on weekends in Study settings.
- Undo history lasts for the current dashboard tab; your plan itself is saved permanently.

# For the developer

## One-time Google sign-in setup

@me's manifest includes a public `key`, so every install has the same extension ID, no matter where it's loaded from:

```
gdldddddeblbnpnhaimkpkehfflhbmhh
```

Google sign-in is tied to that ID, so once you set it up, it works for everyone who installs @me.

1. In the Google Cloud Console, create a project, like "atme".
2. Under **APIs & Services → Library**, enable the **Google Calendar API**.
3. Open **Google Auth Platform** and set it up:
   - **Branding:** app name `@me`, your support email, and once your site is live, `https://atme.tech` and `https://atme.tech/privacy.html`.
   - **Audience:** **External**.
   - **Data Access:** add `.../auth/calendar.app.created`, `.../auth/calendar.freebusy`, and `.../auth/calendar.events.readonly`.
4. Under **Clients → Create client**, choose **Chrome Extension** and paste the ID above as the **Item ID**.
5. Paste the client ID into `extension/manifest.json` in place of `PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com`, and commit it. Client IDs for Chrome extensions aren't secret.
6. Decide who can sign in:
   - **Testing mode:** only Google accounts you add under **Audience → Test users** (up to 100). Add your judges and teammates here.
   - **Published:** anyone can sign in after clicking past an "unverified app" warning, until Google verifies @me. See [SHIPPING.md](SHIPPING.md).

The scopes are deliberately narrow: @me can read your events, but can only create and edit the calendars it makes itself. It never edits your own events.

## Making a release

There are two ways users get @me, and both are automatic:

- **atme.tech:** every push that changes the `extension` or `site` folder republishes the website, and the workflow zips the extension into it at `atme.tech/atme-extension.zip`. The site's **Download @me** button always gets the newest version.
- **GitHub releases:** when you publish a release (for example, tag `v1.2.0`), `.github/workflows/release.yml` attaches `atme-extension-v1.2.0.zip` plus `atme-extension.zip`, so `/releases/latest/download/atme-extension.zip` always works.

Make sure your client ID is in `extension/manifest.json` first, so Google sign-in works in the download. Both workflows warn you if it's still the placeholder. When you release a new version, also update the version number shown under the Download button in `site/index.html`.

## Demo tips

- Turn on **Settings → Demo mode** so sessions last 10 seconds instead of an hour.
- Good live sequence: import your real syllabus → plan → open Google Calendar in another tab to show the sessions → add a surprise quiz with the chat minimized → show the red ❗ on the toolbar → say "my quiz got cancelled" → hit undo and watch Google Calendar fix itself.
- If Wi-Fi or the AI is slow, paste your syllabus text instead. The built-in reader, planner, and offline quiz questions all work without it.

## What's inside the `extension` folder

| File | What it does |
|---|---|
| `manifest.json` | Extension config: permissions, Google OAuth, background worker |
| `app.html`, `app.js`, `app.css` | The main @me dashboard: calendar, sidebar, and the floating chat |
| `popup.html`, `popup.js` | Toolbar popup: red ❗ alerts, next session, quick actions |
| `options.html`, `options.js` | Settings: Gemini key, Google Calendar, Canvas, demo mode |
| `background.js` | Checks Canvas every 30 min, sets the red ❗ badge, sends notifications, runs session timers and focus mode |
| `blocked.html`, `blocked.js` | The page you see when focus mode blocks a site |
| `lib/planner.js` | All the scheduling logic (free time, sleep cutoff, spreading sessions, conflicts) |
| `lib/gcal.js` | Google Calendar: sign-in, free/busy, the "@me Study" calendar, sync |
| `lib/canvas.js` | Canvas API: courses, assignments, exam events, grade weights |
| `lib/ai.js` | The Gemini API client, with structured output, retries, and model fallbacks |
| `lib/store.js` | Saves everything in `chrome.storage.local` |
| `lib/focus.js` | Site blocking with `declarativeNetRequest` |
| `lib/sample.js` | Offline quiz questions for common science topics |
| `lib/util.js` | Date and time helpers shared by everything |
| `lib/docx.js` | Reads Word (.docx) and PowerPoint (.pptx) files into text, keeping tables as rows and slides with their speaker notes |
| `lib/textsyl.js` | Reads pasted syllabus text without AI, as a backup |
| `lib/csbank.js` | Offline CS practice questions with code, for when the AI isn't available |
| `lib/materials.js` | Course materials (slides, notes, old exams): storage, topic tagging, and quizzes from your notes |
