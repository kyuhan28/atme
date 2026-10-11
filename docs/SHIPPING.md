# Shipping @me to atme.tech

@me is a Chrome extension, so it can't run from a website. Shipping it means three pieces working together:

1. **The website at atme.tech:** a landing page, an install button, and a privacy policy. It's already built, in the `site` folder.
2. **The Chrome Web Store:** one-click installs instead of loading an unpacked folder.
3. **Public Google sign-in:** right now only test users you add by hand can connect Google Calendar. Opening it to everyone takes Google's app verification, which uses your domain.

Do them in this order. The website comes first, because the other two need its privacy policy.

## 0. Put it on GitHub

**Before you push**
1. Paste your Google client ID into `extension/manifest.json` (see the developer section of [SETUP.md](SETUP.md)). It's safe to commit.
2. Never commit `.pem` files. The repo's `.gitignore` already blocks them.

**Create the repo and push.** On GitHub, click **New repository**, name it `atme`, make it **Public**, and leave "Add a README" and "Add a license" unchecked, since the repo already has both. Then, in the unzipped `atme` folder:

```
git init
git add .
git commit -m "@me 1.2.0"
git branch -M main
git remote add origin https://github.com/kyuhan28/atme.git
git push -u origin main
```

Prefer not to use the command line? GitHub Desktop works too: **File → Add local repository**, choose the `atme` folder, then **Publish repository**. Avoid dragging files into GitHub's web uploader, because it can skip hidden folders like `.github`.

**Publish a release.** In the repo, click **Releases → Draft a new release**, create a tag like `v1.2.0`, give it a title, and click **Publish release**. Within a minute, the release workflow attaches `atme-extension-v1.2.0.zip`, which is the file users download.

**Make the repo easy to find.** On the repo page, click the ⚙ next to **About** and add the website (`https://atme.tech`), a one-line description, and topics like `chrome-extension`, `education`, `study-planner`, and `hackru`. Under **Settings → General → Social preview**, upload `docs/screenshots/banner.png`.

## Your details

The site already uses your GitHub username, `kyuhan28`, and contact email, `hankyumin05@gmail.com`. To change either one later, search the `site` folder for them and replace every match.

## 1. Get the domain

Buy `atme.tech` from any registrar, like [get.tech](https://get.tech), Namecheap, or Porkbun. HackRU is an MLH event, and MLH events often offer a free .tech domain to participants, sometimes with a "best domain name" prize, so check the hackathon's sponsor page before paying.

## 2. Put the website live

**Option A: GitHub Pages (free, already set up).** The repo includes `.github/workflows/pages.yml`, which publishes the `site` folder every time it changes.

1. Push the repo to GitHub.
2. In the repo, go to **Settings → Pages**, and under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Go to the **Actions** tab, open **Deploy atme.tech**, and click **Run workflow** once.
4. Back in **Settings → Pages**, type `atme.tech` under **Custom domain** and save.
5. At your domain registrar, add these DNS records:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | CNAME | `www` | `kyuhan28.github.io` |

6. Wait for DNS to update. It usually takes minutes, but can take up to a day. Then check **Enforce HTTPS** in **Settings → Pages**.

**Option B: Netlify or Cloudflare Pages (also free).** Drag the `site` folder onto Netlify's deploy page, or connect the repo with the output folder set to `site` and no build command. Then add `atme.tech` as a custom domain and follow the DNS records they show you.

Either way, check that `https://atme.tech` and `https://atme.tech/privacy.html` both load, and that **Download @me** downloads `atme-extension.zip`. With GitHub Pages, the workflow builds that zip automatically. With Netlify, there's no workflow, so zip the `extension` folder yourself as `atme-extension.zip` (with an `atme-extension` folder inside) and put it in the `site` folder before uploading.

## 3. Verify the domain with Google

Google needs proof that you own atme.tech before it will show it on the sign-in screen.

1. Go to [Google Search Console](https://search.google.com/search-console) and add a **Domain** property for `atme.tech`.
2. Add the TXT record it gives you at your registrar, then click **Verify**.

Use the same Google account as your Google Cloud project.

## 4. Publish to the Chrome Web Store

**Set up**
1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). There's a one-time $5 fee.
2. Zip the **contents** of the `extension` folder, so `manifest.json` is at the top level of the zip, not inside a folder:
   ```
   cd extension && zip -r ../atme-extension.zip . -x "*.DS_Store"
   ```
3. Remove the `"key"` line from the copy of `manifest.json` you upload. That key keeps the GitHub version's ID the same for everyone, but the store assigns the store version its own ID.

**Fix Google sign-in for the store version**

The store gives @me a new extension ID, and Google sign-in is tied to the ID.

1. Upload the zip once as a draft. The dashboard shows the new item ID.
2. In Google Cloud, go to **Google Auth Platform → Clients → Create client**, choose **Chrome Extension**, and paste the store item ID.
3. Put that new client ID in `manifest.json`, zip again, and upload the new zip to the same draft.

Keep your original client ID for testing the unpacked version on your own computer.

**The store listing**

| Field | What to enter |
|---|---|
| Name | @me Study Operator |
| Summary | Turns your syllabus into a study plan on Google Calendar, and keeps it working when your week changes. |
| Category | Education |
| Homepage | `https://atme.tech` |
| Privacy policy | `https://atme.tech/privacy.html` |
| Icon | `extension/icons/icon128.png` |
| Screenshots | At least one, 1280 × 800. Use `docs/screenshots` as a starting point. |
| Small promo tile | 440 × 280. A crop of `docs/screenshots/banner.png` works. |

**Description** (paste and adjust):

> @me reads your syllabus and turns it into a study plan on your Google Calendar, then keeps the plan working when your week changes.
>
> Import a syllabus as a PDF, Word file, or pasted text, or connect Canvas. @me finds every exam, lab, project, lecture topic, and grade weight, then schedules study sessions around your classes and Google Calendar events, before your bedtime, with more time for the exams that count most. Projects start the day they're assigned.
>
> When something changes, @me moves the session that clashed and flags it. Quizzes and practice exams are written from your own slides and notes, a proficiency bar for every topic shows what you actually know, and focus mode blocks distracting sites during sessions. Every change can be undone.
>
> Everything is stored in Chrome on your computer. @me has no servers, no ads, and no tracking. AI features use your own free Gemini API key.

**The Privacy practices tab**

*Single purpose:* "@me plans and tracks a student's study time around their classes, deadlines, and calendar."

*Permission justifications:*

| Permission | Justification |
|---|---|
| `storage` | Saves the student's classes, deadlines, study plan, and settings on their computer. |
| `alarms` | Runs scheduled checks for new Canvas assignments and Google Calendar changes, study session timers, and the morning briefing. |
| `notifications` | Tells the student when @me moves a study session, finds a new quiz, or has their morning briefing. |
| `identity` | Signs the student in to Google so @me can read their calendar and sync its own calendars. |
| `declarativeNetRequest` | Focus mode: during a study session, redirects YouTube, Instagram, TikTok, and Reddit to a "back to studying" page. Rules are removed when the session ends. |
| Host: `generativelanguage.googleapis.com` | Sends requests to Google's Gemini API, with the student's own key, to read syllabi and write quizzes. |
| Host: `www.googleapis.com`, `oauth2.googleapis.com` | Google Calendar API, and signing out of Google. |
| Host: YouTube, Instagram, TikTok, Reddit | Needed for focus mode to redirect these sites during a study session. @me doesn't read anything on them. |
| Optional host: `https://*/*` | Requested only for the student's own school Canvas address, and only when they choose to connect Canvas. |

*Remote code:* No. All of @me's code is in the package.

*Data usage:* Answer based on what @me actually handles, as described in the privacy policy. It stores data on the student's computer, sends course content to Google's Gemini API with the student's own key, and never sends data to the developer, sells it, or uses it for anything unrelated to studying. When you're unsure whether a category applies, disclose it. It's better to over-disclose than to have the listing rejected.

**Submit for review.** Reviews often take a few days, and can take longer for extensions with host permissions like these. You'll get an email either way.

## 5. Open Google sign-in to everyone

1. In Google Cloud, go to **Google Auth Platform → Branding** and fill in:
   - App name: `@me`
   - Logo: `docs/screenshots/logo.png`, resized to 120 × 120
   - Home page: `https://atme.tech`
   - Privacy policy: `https://atme.tech/privacy.html`
   - Authorized domain: `atme.tech`
2. Go to **Audience** and click **Publish app**.
3. @me's Google Calendar permissions are considered sensitive, so Google reviews them before the "unverified app" warning goes away. In **Verification Center**, submit:
   - A short explanation of why @me needs each permission. The privacy policy's Google Calendar table works.
   - A demo video, uploaded to YouTube as unlisted, showing the Google sign-in screen and how @me uses calendar data.

Verification can take days to weeks. Until it's done, up to 100 people can still sign in after clicking past the warning.

## 6. After the store listing goes live

1. In `site/index.html`, replace the "Coming soon" text in the **Get @me** section with the store link, and point both **Get @me** buttons at it. You can rename them **Add to Chrome**.
2. Push. The workflow republishes the site automatically.

## Later: AI without a key

Right now, students bring their own free Gemini key. To make AI work out of the box, you'd add a small backend, for example at `api.atme.tech`, that holds your key and forwards requests. That costs money per request, needs rate limits so it can't be abused, and means updating the privacy policy, since requests would pass through your server.

## Checklist

- [ ] Get atme.tech
- [ ] Turn on GitHub Pages and add the DNS records
- [ ] Check that the site and privacy policy load over HTTPS
- [ ] Verify atme.tech in Google Search Console
- [ ] Register as a Chrome Web Store developer
- [ ] Upload a draft, create a new OAuth client with the store item ID, and re-upload
- [ ] Fill in the listing and privacy practices, then submit for review
- [ ] Fill in Google Auth Platform branding, publish the app, and submit for verification
- [ ] Swap "Coming soon" for the store link once the listing is live
