# Presenting @me

## The story

Tell it as one student's real semester: **you**, a CS major taking CS 0445 plus a public speaking gen-ed.

> Every semester starts with syllabi, Canvas, and a calendar that don't talk to each other, and the plan falls apart the first time something changes. @me reads your actual course materials, builds a study plan on your Google Calendar, and keeps fixing it as your week changes.

Three ideas to repeat: **it reads your real class**, **it knows what matters**, and **it keeps the plan working when life happens**.

## Set up before you present

**The demo profile** (for the live "starts from nothing" moment)
- [ ] A separate Chrome profile with @me loaded, your AI key added and tested, and Google Calendar connected, but **no classes added**. Connecting Google live wastes time and can fail on venue Wi-Fi.
- [ ] **Settings → Demo mode** on, so sessions last 10 seconds.
- [ ] Chrome notifications allowed in your computer's settings, so the ❗ notification can show.
- [ ] Google Calendar open in a second tab, on week view.
- [ ] Browser zoom at 110 to 125% so the back row can read it.

**Files on your desktop**
- [ ] Your CS 0445 syllabus (PDF or Word), plus its text copied to a note in case you need to paste it.
- [ ] Your public speaking syllabus as text.
- [ ] A lecture deck as `.pptx`, like the recursion slides.

**The backup profile**
- [ ] A second profile that's already fully set up and planned. If anything breaks, switch to it and keep talking.

**The morning of**
- [ ] Test the AI key once. On Gemini's free tier, avoid extra requests after that.
- [ ] Close other tabs and turn on Do Not Disturb.
- [ ] Find one real, sourced statistic about students and time management to open with. Don't guess at a number.
- [ ] Check HackRU's rules on prior work, and be ready to say what you built before the event and what you added during it.

## The 3-minute demo

| Time | What you do | What you say |
|---|---|---|
| 0:00 | Open with your statistic. Show the empty @me dashboard. | "I'm a CS major. Here's my semester, and @me knows nothing about it yet." |
| 0:15 | Import the CS 0445 syllabus. Answer "Move it to this semester?" and "Which recitation are you in?" | "It read every lecture topic, lab, project, and grade weight, and it asks instead of guessing." |
| 0:40 | Paste the public speaking syllabus. Click **That's all**, answer setup, and set public speaking to **None**. | "I'm a CS major. I don't need public speaking prep, so that class only tracks deadlines." |
| 1:00 | Click **Yes, plan it**, accept **Add classes and deadlines**, then switch to Google Calendar. | "Study sessions, lectures, and every deadline are on my Google Calendar, each on its own calendar." |
| 1:15 | Point at a project block, then a coding block. Tap one for **Why this time?** | "Project 2 starts the day it's assigned, not the night before. Every session says what to do, like coding practice for the midterm." |
| 1:35 | Click **📎 Slides & notes** and drop in the lecture `.pptx`. | "Now the quizzes come from my professor's actual slides." |
| 1:50 | Start a session, try opening YouTube, then take the quiz and miss one question. | "Focus mode blocks distractions. The quiz uses real code from the slides, and since I missed one, it schedules a review." |
| 2:05 | Click **✨ Explain it** on the question you missed. | "Gemini explains it step by step, from my own slides. It can grade my free-response answers too." |
| 2:10 | Point at the 📊 Proficiency bar for that topic as it moves. | "Every bar comes from real test scores, not how confident I feel. This is how I know what to study." |
| 2:20 | Add a Google Calendar event on top of a study session, then switch back. | "Life happens. @me noticed, moved the session, and flagged it with this red ❗." |
| 2:40 | Type "undo that." | "Anything it does can be undone, and Google Calendar fixes itself." |
| 2:50 | Close. | "@me reads your real class, knows what matters, and keeps the plan working. Thank you." |

**If you're running long, cut in this order:** the "Why this time?" tap, the YouTube block, then the public speaking class (say it instead of showing it).

## Key points to say out loud

- **It acts, not just answers.** Most AI study tools are chatbots. @me changes your actual calendar and keeps it correct.
- **It reads your real class.** Syllabi in any format, Canvas, and your lecture slides. Quizzes use your professor's terms and code, and say which slide each answer came from.
- **It knows what matters.** Bigger exams get more time, gen-eds can get none, projects start early, and you can skip any session that isn't worth it.
- **Exam practice on demand.** "Review for my midterm" gives a full practice set from your own slides, with free-response model answers and a score by topic.
- **It shows what you actually know.** Proficiency bars for every topic, built only from scored questions, with one-click self-checks.
- **It adapts to how you're doing.** Quiz scores and check-ins change the plan, missed sessions get rescheduled, and weak topics come back on a spaced schedule.
- **It protects the student.** A sleep cutoff, earlier nights before exams, focus mode, and a daily study limit.
- **It's built for trust.** Undo everything, every session explains itself, and the red ❗ tells you when @me changed something on its own.
- **Privacy by design.** Everything stays in your browser. Google access is read-only for your own events, and @me only edits the calendars it creates.

## For technical judges

- **A real Chrome extension** (Manifest V3) with a background worker that checks Canvas and Google Calendar on its own, even when the dashboard is closed.
- **Diff-based calendar sync** across three calendars. @me compares its plan to what it wrote before and only changes the difference, which is why undo and replanning fix Google Calendar automatically.
- **No dependencies, no build step.** Plain JavaScript. Word and PowerPoint files are unzipped and read in the browser by hand.
- **Gemini does the heavy lifting.** It reads PDFs, screenshots, and photos of notes, answers in a strict schema so output always parses, and tutors from your own slides.
- **Works without AI too.** A built-in syllabus reader, offline CS questions with code, and quizzes made from your own notes keep it working when the network doesn't.
- **Hardened.** A startup safety net, crash-loop safe mode, and validation of every AI response before it touches your data.

## Questions to be ready for

**"How is this different from a calendar or an auto-scheduler?"**
General schedulers move tasks around, but they don't read your syllabus, know your exam topics or grade weights, or quiz you on your professor's slides. @me is built around how courses actually work.

**"What if the AI gets something wrong?"**
Dates moved from an old syllabus are marked "Estimated," the built-in reader says to double-check, every change can be undone, and the × menu fixes any single block.

**"How is my data handled?"**
It stays in Chrome on your computer. Your AI key and Canvas token only go to those services. Google access is read-only for your events, plus editing @me's own calendars.

**"Why a Chrome extension?"**
Students already live in the browser with Canvas and Google Calendar. An extension can block distractions, show a badge, and run checks in the background, which a website can't.

**"Who is this for?"**
Any student, but especially those juggling work or a heavy course load, and first-year students still learning to manage a college schedule.

**"What did you build during the hackathon?"**
Answer honestly, based on HackRU's rules.

**"What's next?"**
A Chrome Web Store release, a backend so students don't need their own AI key, and study groups that share availability.

## A handy line for judges

If a judge asks "what else can it do?", type **/help**. It lists every feature with tap-to-try examples using your own classes, plus suggestions for what to do next.

## If something breaks on stage

- **The AI is slow or down:** paste the syllabus text instead. The built-in reader handles it, and offline quizzes still work, including questions from your slides.
- **Google Calendar doesn't update:** keep going on @me's calendar, then show the backup profile's Google Calendar.
- **Anything else:** switch to the backup profile without apologizing, and keep the story moving.
- **A safe mode banner appears:** click **Turn safe mode off** and continue.

## For your Devpost page

- **Record a 2-minute video** of the demo. It's your backup if the live demo fails, and many judges watch it first.
- **Add screenshots:** the calendar with session types, the ❗ alert, a code quiz "based on" your slides, and Google Calendar with the three @me calendars.
- **Write four short sections:** the problem, what @me does, how you built it, and challenges. Good challenges to mention: reading Word and PowerPoint files with no libraries, keeping three Google calendars in sync with undo, and making everything work without AI when keys or Wi-Fi fail.
- **Built with:** JavaScript, HTML, CSS, Chrome Extensions (Manifest V3), Gemini API, Google Calendar API, Canvas LMS API, OAuth 2.0.
- **Link the GitHub repo.**
