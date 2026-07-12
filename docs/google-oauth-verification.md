# Google OAuth verification submission package

> Draft submission package for Google's sensitive-scope verification of the
> WasmHatch OAuth client at https://wasmhatch.com.

- Status: infrastructure provisioned; sensitive-scope verification not yet
  submitted
- Canonical app URL: https://wasmhatch.com (live on Vercel with header CSP)
- Privacy policy: https://wasmhatch.com/privacy.html (source:
  [`public/privacy.html`](../public/privacy.html)) — live
- Runtime and deployment contract: [`docs/google-oauth.md`](google-oauth.md)
- Scope classifications last verified against Google's documentation:
  2026-07-12

### Provisioned infrastructure (2026-07-13)

- Google Cloud project: `wasmhatch`
- OAuth client: "WasmHatch Web" (Web application), authorized JavaScript
  origin `https://wasmhatch.com`. Client ID
  `479452292764-reiggaur6qtqiucbg9r46bni3t42edpe.apps.googleusercontent.com`
  (a public configuration value, not a secret). Stored as the Vercel
  production env var `VITE_GOOGLE_CLIENT_ID`; `OperatorPage`/the chat surface
  read it via `import.meta.env.VITE_GOOGLE_CLIENT_ID`.
- OAuth consent screen: External, app name "WasmHatch", support and developer
  contact `yusuke8h@gmail.com`. Publishing status is **Testing** — move to
  In production only after the launch surface is ready, and keep launch-day
  scopes to the non-sensitive `drive.file` only (100-user cap risk while
  unverified).
- Enabled APIs: Drive, Sheets, Docs, Slides, Calendar, Picker.
- Domain ownership: `wasmhatch.com` verified in Search Console via a Vercel
  DNS TXT record (kept in place so verification persists).

Remaining before submission: add the app logo on the consent screen, then
submit the sensitive scopes for verification with the demo video below.

## 1. Requested scopes

| Scope | Tier | Verification impact | Justification (one line) |
| --- | --- | --- | --- |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive | None — no verification, no warning screen, no user cap | Already-in-use baseline: per-file access to files the user selects through the Google Picker or that WasmHatch creates |
| `https://www.googleapis.com/auth/spreadsheets` | Sensitive | Brand verification + scope justification + demo video | Open a spreadsheet the user references by URL or ID in chat and apply only diff-approved cell edits |
| `https://www.googleapis.com/auth/documents` | Sensitive | Brand verification + scope justification + demo video | Create a Google Doc from a reviewed workspace artifact, or update a Doc the user references by URL or ID |
| `https://www.googleapis.com/auth/presentations` | Sensitive | Brand verification + scope justification + demo video | Create a Google Slides deck from a reviewed outline, or update a deck the user references by URL or ID |
| `https://www.googleapis.com/auth/calendar.events` | Sensitive | Brand verification + scope justification + demo video | List events for scheduling context and create or update events only after an explicit review card is approved |

Deliberately **not** requested:

- `https://www.googleapis.com/auth/drive` (full Drive) is **Restricted**. It
  would trigger a CASA security assessment (roughly $500–1,000 per year) and
  grants far more than any WasmHatch feature needs. Do not add it to the
  consent configuration.

Tier facts this plan relies on (verified 2026-07-12):

- Non-sensitive (`drive.file`): no verification, no unverified-app warning, no
  user cap.
- Sensitive, verified: brand verification + per-scope justification + demo
  video; $0; nominal ~10 days, realistically 2–6 weeks end to end.
- Sensitive, **unverified**: users see the unverified-app warning
  interstitial, and the app is subject to a **100-user lifetime cap** for
  those grants.

## 2. Cloud Console form text

Paste the blocks below verbatim into the verification form. Each block is one
paragraph so it survives copy-paste into a form textarea. If a field imposes a
character limit, trim the closing data-handling sentence first — the feature
and narrower-scope sentences are the parts reviewers must see.

### 2.1 Application description (overall)

```text
WasmHatch (https://wasmhatch.com) is an open-source, fully client-side AI workspace: a static web application in which a user describes business work in natural language, the app plans it with an AI model of the user's choice, and every durable effect is shown as an exact preview the user must approve before anything is written. There is no WasmHatch backend server. Google authorization uses the Google Identity Services token model in the browser: access tokens are held only in the memory of the open tab, never persisted, never proxied, and attach only to requests the browser makes directly to googleapis.com. A credential-broker layer keeps token text out of AI-model calls, generated scripts, and logs, and the app contains no analytics or tracking. The requested scopes power, respectively: opening and editing spreadsheets the user references by URL or ID in chat (spreadsheets), creating and updating documents (documents), creating and updating presentations (presentations), and listing plus creating calendar events after explicit review (calendar.events). The non-sensitive drive.file scope remains in use for Picker-based per-file access.
```

### 2.2 `https://www.googleapis.com/auth/spreadsheets`

```text
This scope powers WasmHatch's core feature: the user pastes a Google Sheets URL or spreadsheet ID into the chat, WasmHatch reads the referenced range so the user and the AI planner can see and transform the data, and it writes back only the exact cell changes the user approves in an explicit diff review. A narrower scope is insufficient: drive.file covers only files created by the app or selected through the Google Picker, so it cannot open a spreadsheet the user references by URL or ID in conversation, which is the product's primary entry path; spreadsheets.readonly cannot apply the approved edits. Data handling is fully client-side: WasmHatch has no server, access tokens live only in the memory of the open browser tab and are never persisted, all requests go directly from the browser to googleapis.com, the app contains no analytics, a credential broker keeps token text out of AI-model calls, generated scripts, and logs, and every write requires a user-approved diff.
```

### 2.3 `https://www.googleapis.com/auth/documents`

```text
This scope powers document creation and editing: the user asks WasmHatch to turn a reviewed workspace artifact (for example a Markdown report produced in the app) into a new Google Doc, or to update a Doc they reference by URL or ID in chat. The app shows the exact content that will be written and writes only after the user approves it. A narrower scope is insufficient: drive.file reaches only Picker-selected or app-created files, so it cannot open a document the user references by URL or ID in conversation, and documents.readonly cannot create or update documents. Data handling is fully client-side: WasmHatch has no server, access tokens live only in the memory of the open browser tab and are never persisted, all requests go directly from the browser to googleapis.com, the app contains no analytics, a credential broker keeps token text out of AI-model calls, generated scripts, and logs, and every write requires explicit user approval of the previewed change.
```

### 2.4 `https://www.googleapis.com/auth/presentations`

```text
This scope powers slide-deck creation and editing: the user asks WasmHatch to turn a reviewed outline or report into a new Google Slides presentation, or to update a deck they reference by URL or ID in chat. The app shows the slides that will be created or changed and writes only after the user approves that preview. A narrower scope is insufficient: drive.file reaches only Picker-selected or app-created files, so it cannot open a presentation the user references by URL or ID in conversation, and presentations.readonly cannot create or edit slides. Data handling is fully client-side: WasmHatch has no server, access tokens live only in the memory of the open browser tab and are never persisted, all requests go directly from the browser to googleapis.com, the app contains no analytics, a credential broker keeps token text out of AI-model calls, generated scripts, and logs, and every write requires explicit user approval of the previewed change.
```

### 2.5 `https://www.googleapis.com/auth/calendar.events`

```text
This scope powers scheduling: the user asks WasmHatch to list upcoming events as context and to create or update an event derived from their work (for example turning a project table into scheduled milestones). The app shows the full event details — title, time, timezone, attendees, and whether invitations or notifications will be sent — and writes only after explicit approval. calendar.events is already the narrowest write-capable Calendar scope: Google Calendar has no Picker-equivalent or per-item scope comparable to drive.file, calendar.events.readonly and calendar.freebusy cannot create or update events, and we deliberately do not request the broader calendar scope (WasmHatch needs no access to calendar settings, sharing, or ACLs). Data handling is fully client-side: WasmHatch has no server, access tokens live only in the memory of the open browser tab and are never persisted, all requests go directly from the browser to googleapis.com, the app contains no analytics, a credential broker keeps token text out of AI-model calls, generated scripts, and logs, and every write requires explicit user approval.
```

### 2.6 `https://www.googleapis.com/auth/drive.file` (baseline, non-sensitive)

```text
This non-sensitive scope is the baseline file-access path: the user selects a file through the Google Picker, or WasmHatch creates a file, and the grant covers only those files. It powers per-file open and save without any broad Drive visibility. It is listed for completeness; the sensitive scopes above are requested only for the flows drive.file cannot serve, such as opening a resource the user references by URL or ID in chat. Data handling is identical to the other scopes: fully client-side, memory-only tokens, direct browser-to-googleapis.com requests, no analytics, and user-approved previews before every write.
```

## 3. Demo video script (target length ≤ 3:00)

Production requirements:

- English narration or captions throughout.
- 1920×1080 or higher; the browser address bar must stay visible whenever the
  app or a Google page is on screen.
- Record the consent flow **without cuts** from clicking **Connect Google** to
  the granted state. Pause on the consent screen long enough for each scope
  line to be read.
- The GIS popup URL contains the OAuth client ID (`client_id=` parameter);
  make sure it is legible at least once, as Google's reviewers ask for it.
- Use a test Google account populated with realistic but synthetic data. No
  real customer data, real attendee emails, or credentials on screen.
- Upload as an unlisted YouTube video and paste the link into the
  verification form.

| Time | Shot | On screen | Narration / caption |
| --- | --- | --- | --- |
| 0:00–0:10 | App and domain | Browser at `https://wasmhatch.com`, address bar visible; workspace home | "This is WasmHatch, a client-side AI workspace. Everything runs in the browser; there is no WasmHatch server." |
| 0:10–0:20 | Privacy policy | Scroll to the footer, click **Privacy Policy**; `https://wasmhatch.com/privacy.html` loads on the same domain | "The privacy policy is linked in the app and hosted on the same domain." |
| 0:20–0:45 | OAuth consent | Click **Connect Google**. GIS popup: account chooser, then the consent screen showing app name **WasmHatch**, the logo, the privacy policy link, and the exact requested scopes (Sheets, Docs, Slides, Calendar events, drive.file). Hold so each scope line is legible; the popup URL with `client_id=` is visible. Approve. | "The consent screen lists exactly the scopes the app requests. The token is held in tab memory only and is never persisted." |
| 0:45–1:25 | Sheets (`spreadsheets`) | Paste a spreadsheet URL into the chat; WasmHatch opens the referenced range. Ask for an edit ("normalize the status column"). The app shows a proposal and an exact cell diff. Approve. Switch to the Google Sheets tab and show the applied change. | "The user references a spreadsheet by URL — this is why drive.file alone is not enough. Nothing is written until the exact cell diff is approved." |
| 1:25–1:50 | Docs (`documents`) | Ask WasmHatch to create a Google Doc from the reviewed report artifact. Show the content preview and approval. Open the created Doc in Google Docs. | "Creating a document from a reviewed artifact. The full content is approved before the Doc is created." |
| 1:50–2:15 | Slides (`presentations`) | Ask WasmHatch to create a Slides deck from the outline. Approve the preview. Open the created deck in Google Slides. | "The same review-first flow for presentations." |
| 2:15–2:45 | Calendar (`calendar.events`) | Ask "what is on my calendar this week?" — the event list appears in the app. Ask to create a review meeting. The approval card shows title, time, timezone, attendees, and notification behavior. Approve. Show the event in Google Calendar. | "Events are listed for context; creating one requires approving the full event details, including who gets notified." |
| 2:45–3:00 | Revocation and close | Click **Revoke Google access** in the app; mention `myaccount.google.com/permissions`. End card: WasmHatch — https://wasmhatch.com — privacy policy URL. | "Access tokens live only in this tab, and the grant can be revoked at any time in the app or in the user's Google Account." |

## 4. Submission checklist

Work through these in order. Items 1–6 are prerequisites; Google rejects or
stalls submissions with unverified domains or mismatched URLs.

1. [ ] **Domain ownership** — verify the `wasmhatch.com` domain property in
   [Google Search Console](https://search.google.com/search-console) via DNS
   TXT record (domain purchase is in progress; this is blocked until DNS is
   under our control). The verified owner account must be an Owner/Editor on
   the Google Cloud project.
2. [ ] **Enable APIs** in the Cloud project: Google Sheets API, Google Docs
   API, Google Slides API, Google Calendar API, Google Drive API, and Google
   Picker API.
3. [ ] **Extend the production CSP** — `vite.config.ts` currently allowlists
   only `https://sheets.googleapis.com` in `connect-src`. Add the exact hosts
   the Docs, Slides, Calendar, Drive, and Picker implementations call (for
   example `docs.googleapis.com`, `slides.googleapis.com`,
   `www.googleapis.com`) before recording the demo video, or the demoed
   features will be blocked by the app's own policy.
4. [ ] **Consent screen branding** — app name **WasmHatch**, 120×120 logo,
   user support email, developer contact email, homepage
   `https://wasmhatch.com`, privacy policy
   `https://wasmhatch.com/privacy.html`. Homepage and privacy policy must be
   live, on the same verified domain, and consistent with each other.
5. [ ] **Privacy policy live check** — `public/privacy.html` deploys to
   `https://wasmhatch.com/privacy.html`, loads over HTTPS, and contains the
   Google API Services User Data Policy **Limited Use** disclosure.
6. [ ] **Authorized JavaScript origins** — `https://wasmhatch.com`
   (production) plus `http://localhost:4173` and `http://localhost:5173` for
   local preview/dev. The legacy `https://haya-inc.github.io` origin may stay
   on the client during the migration, but every URL in the verification
   submission must be on `wasmhatch.com`.
7. [ ] **Declare exactly the scopes in Section 1** on the consent screen's
   data-access configuration. Do not add the Restricted full-Drive scope.
8. [ ] **Publish status** — move the consent screen from **Testing** to **In
   production**, then submit for verification with the Section 2 texts and
   the Section 3 video link.
9. [ ] **Respond promptly** to follow-up emails from Google's verification
   team; stale requests are closed and must be restarted.

Timeline expectation: verification costs $0; Google's nominal figure is about
10 days, but realistically plan for **2–6 weeks**, including at least one
round of reviewer questions.

**Launch-day rule:** until verification is approved, the production app must
request **only the non-sensitive `drive.file` scope**. Requesting an
unverified sensitive scope in production shows every user the unverified-app
warning interstitial and — worse — counts against a **100-user lifetime cap**
that a launch audience would burn through immediately. Keep the
sensitive-scope request path behind a flag that ships only after approval;
exercise sensitive scopes before that only with allow-listed test users on a
Testing-status (or separate development) client.

## 5. Quarterly re-verification

Google reclassifies scopes and changes verification requirements without a
migration window. Re-verify this document quarterly:

- Last verified: **2026-07-12** — `drive.file` Non-sensitive;
  `spreadsheets`, `documents`, `presentations`, `calendar.events` Sensitive;
  full `drive` Restricted (CASA, ~$500–1,000/yr).
- Next check due: **2026-10-12**.
- Re-check: each API's scope classification page, the OAuth verification
  requirements (demo video, CASA tiers, fees), and whether the Limited Use
  wording required in `public/privacy.html` has changed.
