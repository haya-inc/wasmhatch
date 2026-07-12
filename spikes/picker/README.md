# Spike: Google Picker + `drive.file` folder access

> **Verification harness only.** This directory is not part of the WasmHatch
> application build (the Vite build only bundles the repository root
> `index.html` and `src/`), and it must **never be deployed** or linked from
> the app.
>
> **Do not advertise folder tasks yet.** Whether a Picker folder pick grants
> anything useful under `drive.file` is a documented gray zone in Google's
> materials. Until a run of this harness is recorded below with passing
> results, every public and in-app claim stays at the current per-file
> boundary: "hand me files". No folder workflows in the README, docs, or UI.

## The question this spike answers

With the OAuth scope `https://www.googleapis.com/auth/drive.file` (the
non-sensitive, per-file scope that `docs/google-oauth.md` names as the planned
promotion path), when the user picks a **folder** through the Google Picker
(`DocsView` with `setSelectFolderEnabled(true)` / `setIncludeFolders(true)`),
does the app gain access to:

- **(a)** the folder resource itself — `files.get` on the folder id;
- **(b)** the folder's **existing** children — `files.list` with
  `'<folderId>' in parents and trashed = false`;
- **(c)** children **added later** by the user through the Drive UI — the same
  listing re-run after adding a new file outside the harness?

`index.html` in this directory is a single-file, no-build harness that runs
exactly these calls and renders PASS/FAIL, HTTP status, and an interpretation
for each, plus a copyable JSON summary.

Key traps the harness accounts for:

- Under `drive.file`, Drive reports items the app has no per-item grant for as
  **404 not-found** (it hides them), while **403** means a scope- or
  grant-level denial on an item Drive admits exists. The rendered explanations
  distinguish the two.
- `files.list` can return **HTTP 200 with zero children** either because the
  folder is empty or because `drive.file` is hiding the children. That is why
  the procedure requires a test folder that already contains a file.
- `drive.file` **always** covers files the app created itself. A successful
  `files.create` into the folder is therefore *not* evidence of folder read
  access, and harness-created files are tagged in listings so they are never
  mistaken for real children.

## Prerequisites (one-time Google Cloud setup)

1. Create (or reuse) a throwaway **Google Cloud project** at
   <https://console.cloud.google.com/>.
2. **Enable two APIs** under *APIs & Services → Library*:
   **Google Drive API** and **Google Picker API**.
3. Configure the **OAuth consent screen** (Google Auth Platform → Branding /
   Audience): External audience, publishing status **Testing**, and add the
   Google account you will test with as a **test user**. `drive.file` is a
   non-sensitive scope, so no verification is needed while in Testing.
4. Create an **OAuth client ID** (*Credentials → Create credentials → OAuth
   client ID*), application type **Web application**, with
   `http://localhost:5500` under **Authorized JavaScript origins** (origins
   have no path; no redirect URI is needed for the GIS token model).
5. Create an **API key** (*Credentials → Create credentials → API key*) and
   restrict it: website restriction `http://localhost:5500/*`, API restriction
   **Google Picker API** only.
6. Optional but recommended: note the **project number** (Cloud console
   overview page). The harness passes it to `PickerBuilder.setAppId()` so the
   per-file grant is attributed to the same project as the OAuth client — a
   mismatch there is a known cause of false FAILs.

Never commit the client ID, API key, or project number to this repository.
The harness keeps them in page memory only and never persists them.

## Serve the harness

From the repository root, either:

```sh
npx serve spikes/picker -l 5500
```

or:

```sh
python -m http.server 5500 --directory spikes/picker
```

Then open exactly `http://localhost:5500/` — use `localhost`, not
`127.0.0.1`, unless you also authorized that origin. `file://` does not work;
Google Identity Services requires an http(s) origin.

## Run procedure

The whole run must fit inside one token lifetime (about 1 hour); if the token
expires, click step 1 again and continue.

1. **Prepare the fixture first.** In the Drive web UI of the test account,
   create a folder (for example `wasmhatch-picker-spike`) and put **at least
   one ordinary file** in it (a small `.txt` is fine), created *outside* this
   harness. Note the file's name. Without a pre-existing child, the
   children-listing result is uninterpretable.
2. Serve and open the page, paste the **Client ID**, **API key**, and
   optionally the **App ID** (project number).
3. Click **1. Init + sign in**. A Google consent popup opens — sign in with
   the test user and grant the single requested scope (the wording is roughly
   "see, edit, create, and delete only the specific Google Drive files you use
   with this app"). If nothing opens, your browser blocked the popup: allow
   popups for `localhost:5500` and click again.
4. Click **2. Open Picker**, switch to the folders view, and select the
   prepared folder.
5. Click **3. Run checks**. The harness runs `files.get` on the folder,
   `files.list` for its children, and `files.create` of a small marker file
   into it, logging PASS/FAIL + HTTP status + interpretation for each. Verify
   whether the pre-existing file from step 1 appears in the listing.
6. **Later-added child (question c):** in the Drive web UI — not the harness —
   add another new file to the folder. Then click
   **4. Re-check children**. If the new file does not appear, wait about 30
   seconds and re-check once more before concluding.
7. Optional control run: click **2. Open Picker** again, pick a single
   **file** from the docs view, and click **3. Run checks** (runs `files.get`
   plus a content download/export).
8. Click **Copy JSON**, then record the results in the table below.
9. **Cleanup:** delete the `wasmhatch-spike-*.txt` marker file(s) from Drive,
   and revoke the app's access at <https://myaccount.google.com/connections>.
   Delete the throwaway API key/client when the spike is finished for good.

## Results record

Record one row per run. Account type matters: repeat the run on a consumer
Gmail account and on a Google Workspace account (Workspace admin policy can
change the outcome). Each result cell is `PASS/FAIL + HTTP status` (for the
children columns, note the visible-children count too). Redact folder ids if
you prefer; never paste credentials.

| Date | Account type | Picked item | (a) folder `files.get` | (b) children `files.list` | folder `files.create` | (c) later-added child visible | Notes |
| ---- | ------------ | ----------- | ---------------------- | ------------------------- | --------------------- | ----------------------------- | ----- |
|      |              |             |                        |                           |                       |                               |       |
|      |              |             |                        |                           |                       |                               |       |

Paste the harness's JSON summary for each run here for audit:

<details>
<summary>Run JSON summaries</summary>

```json
(paste the copied summary JSON blocks here, one per run)
```

</details>

## Interpreting the results for WasmHatch's advertised boundary

| Observed | Meaning | Consequence for the boundary wording |
| --- | --- | --- |
| (a) folder `files.get` → 404 | The pick granted nothing on the folder resource; under `drive.file` ungranted items read as not-found. | Folder selection is meaningless under this scope. Keep "hand me files"; do not document folder workflows at all. |
| (b) children list → 404 | No access to folder contents through the pick. | **"Hand me files" wording stays.** Folder tasks must not be advertised. |
| (b) → 200 with zero children, or only harness-created files, despite the known fixture file | Drive is hiding pre-existing children: effectively no read-through. | Same as 404: keep "hand me files". |
| (b) → 200 and the pre-existing fixture file is listed | The folder pick extends to existing children in this run. | Folder **read** workflows can be documented, citing the recorded run (date + account type), and must be re-verified before each release that mentions them. |
| `files.create` → PASS (alone) | The app can add files it creates to the picked folder; `drive.file` always covers app-created files. | Supports only a "save new outputs into a folder you picked" claim. Not evidence of folder read access. |
| (c) later-added child visible on re-check | The grant tracks the folder over time, not just a snapshot. | Ongoing folder workflows (e.g., "process new files appearing in this folder" while foregrounded) may be considered for documentation. |
| (c) later-added child not visible | Snapshot-only semantics at best. | Document at most one-shot folder reads; nothing ongoing. |
| Results differ between consumer and Workspace accounts | Behavior is policy- or rollout-dependent. | Document only the narrower behavior; note the divergence in `docs/google-oauth.md`. |

Standing rules regardless of outcome:

- A claim may only be promoted into `README.md`, `docs/`, or UI copy if a
  passing run is recorded in the table above; cite the run date and account
  type next to the claim.
- Google's documentation does not pin this behavior down, so it may change
  without notice. Re-run this harness before any release that advertises a
  folder capability, and when Google announces Picker or Drive scope changes.
- Shared drives may behave differently from My Drive (the harness enables
  `SUPPORT_DRIVES` and sends the `supportsAllDrives` flags); record shared
  drive runs as separate rows.
- This spike page bypasses the app's CSP on purpose (the Picker script
  `apis.google.com/js/api.js` is not in the app allowlist). That is another
  reason it must never ship: promoting Picker into the app requires its own
  CSP and broker design work, per `docs/google-oauth.md`.
