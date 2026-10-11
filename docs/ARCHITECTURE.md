# How @me works

## The pieces

```
 ┌─────────────────────┐      ┌──────────────────────┐
 │  Dashboard (app.js) │◄────►│  chrome.storage      │◄────┐
 │  calendar + chat    │      │  (one shared state)  │     │
 └─────────┬───────────┘      └──────────────────────┘     │
           │ messages                                      │
 ┌─────────▼───────────┐      ┌──────────────────────┐     │
 │ Background worker   │─────►│ Toolbar badge (❗),  │     │
 │ (background.js)     │      │ notifications        │     │
 └─────────┬───────────┘      └──────────────────────┘     │
           │                                               │
   ┌───────┴────────┬──────────────┬──────────────┐        │
   ▼                ▼              ▼              ▼        │
 Canvas API   Google Calendar   Gemini API   Site blocking │
 (every 30m)  (events + sync)   (your key)   (focus mode)  │
                                                           │
 Popup (popup.js) and Settings (options.js) ───────────────┘
```

| File | Job |
|---|---|
| `app.js` | The dashboard: calendar, sidebar, chat, every card and menu |
| `boot.js` | Loads first and shows a clear message if @me can't start, like when files are missing |
| `background.js` | Canvas polling, Google Calendar watch, session timers, focus mode, briefing, badge |
| `lib/planner.js` | All scheduling logic, with no DOM code, so the dashboard and background share it |
| `lib/gcal.js` | Google sign-in, reading events, and syncing the "@me Study," "@me Classes," and "@me Deadlines" calendars |
| `lib/canvas.js` | Current-term detection, assignments, exam events, grade weights, class-time inference |
| `lib/ai.js` | The Gemini API client, with structured output, retries, model fallbacks, and plain-language errors |
| `lib/docx.js` | Reads Word files into text in the browser, keeping tables as rows |
| `lib/materials.js` | Course materials: the list lives in state, the text in its own storage keys; topic tagging, excerpt picking, and offline questions from notes |
| `lib/csbank.js` | Offline CS practice questions with code, matched to lecture topics |
| `lib/textsyl.js` | Reads pasted syllabus text without AI: dated items, weights, class times, lecture rows, holidays |
| `lib/store.js` | Saves everything in `chrome.storage.local` |
| `lib/focus.js` | Site blocking with `declarativeNetRequest` dynamic rules |
| `lib/sample.js` | Offline quiz questions for common science topics |

**One source of truth.** All state lives in `chrome.storage.local`. The dashboard, popup, and background worker read and write it, and broadcast a `state-changed` message when they do.

## Reading syllabi and schedules

The AI returns structured JSON: course, term, weekly meetings (with alternative sections flagged), lecture-by-lecture topics, no-class days, and every graded item with its weight. Then `processSyllabus()`:

1. **Checks the semester.** If every date is in the past, it offers to move the syllabus to the current term by whole 52-week steps, so weekdays stay the same. Moved dates are marked "Estimated."
2. **Asks about sections.** `pickSections()` merges one schedule listed in pieces (Tue and Thu at the same time become one meeting). When there are several different times for the same kind of meeting, or they're labeled as sections, it asks which one is the student's, lectures first, then recitations, labs, and discussions. Unlabeled groups also offer "I go to all of these."
3. **Fills in exam topics.** Exams with no listed topics cover the lectures since the previous exam.

Pasted text and Word files can also skip the AI entirely: `lib/textsyl.js` reads common patterns, tested on CS, history, biology, communication, and math syllabi, like "Week 1 (Aug 25): Colonial America", "Response Paper 1 due Friday, Sept. 12", "Exam 1 (20%) - February 5", "Final (40%): Wednesday 12/16, 3-6pm", "Tu/Th 8-9:30am", course codes like "MATH 1A", and "Lab 3 - Due 9/15", "Midterm (15%): 2025-10-14", "Tuesday 6:00-8:30PM", and schedule rows, and feeds the same flow. It's used whenever there's no AI key or the AI call fails.

PDFs go to Gemini as documents. Word files are unzipped and converted to text in the browser first (`lib/docx.js`), since Gemini doesn't read .docx directly. Screenshots go as images.

Canvas rarely knows when classes meet, so class times also come from repeating Canvas calendar events, each course's syllabus page, the class-schedule importer, the class-times form, and chat.

## Planning

1. Exams held during a class meeting take over that whole meeting (`examSpan()`): the class is hidden, and the full class period counts as busy, even when the exam's own listed length is shorter. An exam with no time listed, on a day its class meets, takes the lecture's slot. Exams outside class time keep their own time. Final exams are the exception, since they usually follow the school's finals schedule: they never assume the lecture time, default to 2 hours when a time is known, and when no time is listed, @me asks the student for it. No class meetings for that course show on the day of its final.
   Busy time comes from class meetings (minus skipped classes, days off, and holidays), weekly routine and one-off events, and Google Calendar events (minus ones the student chose to ignore).
2. For each deadline in the next 3 weeks, `buildPlan()` picks a window of study days (weekdays, plus weekends if allowed) and decides how many sessions it deserves. The rhythm setting picks the window: **steady** looks back 10 study days for exams, 5 for quizzes, and 3 for labs; **closer to deadlines** uses 5, 3, and 2 and puts sessions at the end. Projects (big assignments) start on their `assigned` date, or two weeks out, and get 2 to 5 milestone sessions of 90 minutes or more. Exams get more sessions than quizzes, grade weight raises that further, and sessions are spread across the window.
3. `findSlot()` picks the best opening on a day, preferring the student's favorite time of day and never crossing the sleep cutoff (an hour earlier the night before an exam). Weekdays are capped at 2.5 hours of study and weekend days at 2 hours, and weekends start no earlier than 10 AM.
4. Sessions are labeled after placement, in date order. When an exam has more topics than sessions, each session gets a slice of the topics, and the practice exam is always last.
5. If nothing worth prepping is due in 3 weeks, the plan reaches ahead to the next deadline (up to 10 weeks). When a full session won't fit, it tries a shorter one (30 minutes, or 60 for projects). If nothing fits at all, `diagnose()` finds the reason (no deadlines, only past dates, everything set to no prep, a full calendar with its biggest blockers, or deadlines too close) so the dashboard can explain it and offer a fix.
6. Each class has a study level (`priority`): normal, light (about half the sessions, at most 45 minutes), or none. Single items can be marked `noPrep`. Both keep the deadline but skip prep.
7. Topics marked "not important" (`skipTopics`) are left out of sessions, quizzes, and reviews. An exam gets at most one session per remaining topic plus a practice exam, and a quiz whose topics are all unimportant gets no prep.
8. Every session gets a type (`stype`): coding practice, concept review, practice problems, practice exam, project work, writing, lab work, quick review, or group review. Exam prep alternates concept review with coding practice in CS classes, or practice problems elsewhere, and ends with a practice exam.
9. `coverage()` decides what each block shows: real topics plus the exam they're for, or for labs and projects, the lecture they build on.

## Google Calendar

- **Writing:** `syncPlan()`, `syncClasses()`, and `syncDeadlines()` are diff-based. They compare @me's state to what they previously wrote, then create, update, or delete events to match. Replanning and undo fix the calendar automatically. Class events repeat weekly until the semester ends and use `EXDATE` to skip no-class days.
- **Reading:** timed events 12 hours or longer, and working-location or birthday events, are shown like all-day events instead of blocking time. The dashboard re-reads events every 2 minutes and when the tab regains focus. The background worker does it every 15 minutes. New events that overlap a study session trigger `resolveConflicts()`, a re-sync, and a red ❗ alert.
- **Scopes** are deliberately narrow: `calendar.events.readonly`, `calendar.freebusy` (fallback), and `calendar.app.created` (edit only the calendars @me creates).

## Background worker

- **Google Calendar watch** every 15 minutes, moving study sessions that clash with new events.
- **Canvas polling** every 30 minutes, limited to the courses already imported. New quizzes and exams within 3 days get short "surprise" prep sessions; later items get a normal plan.
- **Session timer** using `chrome.alarms`, so it fires even if the dashboard tab is closed.
- **Focus mode** using `declarativeNetRequest` rules that redirect blocked sites to `blocked.html`.
- **Morning briefing** notification at the student's chosen time.

## Course materials

Slides, notes, study guides, and old exams are converted to text once, when they're added: PowerPoint (with speaker notes) and Word in the browser, PDFs and photos through the AI. Each one is tagged with the lecture topics it mentions (singular and plural both match). When a quiz is built, `contextFor()` pulls the slides and paragraphs that mention the session's topics, within a character budget, with old exams first so their style carries over. Practice-exam sessions ask for 5 questions instead of 3. Offline, `notesQuiz()` turns lines like "Base case: …" into "which term matches this description?" questions.

## Proficiency

Every scored question (session quizzes, practice sets, and self-checks) updates `S.prof`, keyed by class and topic. Self-ratings from check-ins don't count. Each attempt blends into the running score, with bigger attempts weighing more (35% plus 5% per question, up to 75%), so the bar follows recent performance. Levels: under 40% Beginner, 40% Developing, 70% Proficient, 90% Mastered. The trend arrow compares the last two blended scores. Results also update the readiness meters for every upcoming exam that covers the topic.

## Exam practice

Asking to review or practice (or the ✏️ button) opens a setup card for the right exam: topics, 5 to 15 questions, and whether to use course materials or just the topics. Notes pasted there can be saved as materials or used once. The AI returns a mix of multiple-choice and free-response questions with model answers; students self-grade free response. Per-topic scores blend into the readiness meters, and the weakest topic gets a one-click review session or a follow-up set. Offline, the set comes from definitions in the student's notes, the built-in CS questions, and free-response problems with model solutions.

## AI usage

`lib/ai.js` is the only file that talks to AI, and @me runs on Google's Gemini API with the student's own free key. Requests that feed the app (syllabi, schedules, quizzes, practice sets, and free-response grading) send Gemini a `responseSchema` for structured output, and if a model rejects the schema with a 400, the request is retried in plain JSON mode. The AI tutor adds **Grade my answer**, which compares a free-response answer to the model answer, and **Explain it**, which walks through a missed question using the matching course materials. Google Calendar event details are never included in any AI request; the daily briefing only says those times are busy. The app sends a system prompt plus text, PDF, and image content, and `ai.js` turns it into a Gemini request. It retries when Gemini is overloaded, falls back to other Flash models, and turns Google's error reasons into plain advice.

Every AI response is validated before it touches state, and each feature has an offline fallback (a built-in syllabus reader, regex chat and schedule parsers, and built-in question banks), so the app keeps working when the network doesn't.

## Known trade-offs

- The AI key lives in the browser. Fine for personal use; a public version should proxy through a backend.
- Canvas has no push updates for student apps, so polling is the practical option.
- If the dashboard and background worker write state at the same moment, the last write wins. In practice the background worker only writes when it finds something new.
