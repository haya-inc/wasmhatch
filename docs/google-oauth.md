# Google Sheets OAuth in WasmHatch

> Short-lived foreground authorization without a WasmHatch server or refresh
> token.

- Runtime: Google Identity Services OAuth token model
- Contract status: foreground implementation in WasmHatch 0.18.0
- Initial scope: `https://www.googleapis.com/auth/spreadsheets`
- Credential lifetime: browser memory only
- Source: [`src/lib/google-oauth.ts`](../src/lib/google-oauth.ts)

## Deployment model

WasmHatch is a static application, so the foreground release uses the Google
Identity Services token model. A user gesture opens Google's account and consent
popup. Google returns a short-lived access token directly to the browser. The
OAuth host stores it in an ECMAScript private field and exposes only a
`BearerCredentialProvider` to the credential broker.

There is no client secret, authorization-code endpoint, refresh token, silent
refresh, local storage, OPFS storage, or WasmHatch account. When the token enters
its final 30 seconds, WasmHatch treats it as expired and requires another click
on **Reconnect Google Sheets**. This is intentionally different from the future
server adapter, which needs a separate durable credential trust model.

The public project page does not bundle a Haya-wide OAuth client. A deployment
may provide `VITE_GOOGLE_CLIENT_ID` at build time, or a user may paste their Web
client ID into the foreground session. A client ID is public application
configuration, not a client secret, but WasmHatch still does not persist it.

## Configure a Google Cloud project

1. Create or select a Google Cloud project and enable the Google Sheets API.
2. Configure OAuth branding, support contact, audience, and test users.
3. Create an OAuth client with application type **Web application**.
4. Add every exact origin that can open the operator under **Authorized
   JavaScript origins**. Origins contain scheme and host, but no path:
   - `https://haya-inc.github.io`
   - `http://localhost:4173` for the standard local preview
5. Add the Sheets scope to the consent configuration:
   `https://www.googleapis.com/auth/spreadsheets`.
6. Complete Google's sensitive-scope verification before making a public client
   available beyond an allowed testing or organizational exception.

See Google's [GIS setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid),
[token-model guide](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
and [Sheets scope classification](https://developers.google.com/workspace/sheets/api/scopes).

## Scope truth

The initial Sheets scope is sensitive and can read and edit every spreadsheet
the selected Google account permits. A broker binding still limits each
WasmHatch transport to the exact spreadsheet ID, range, and operations selected
for that request, but it does not make the underlying OAuth grant per-file.

This is a deliberate P0 compromise for direct spreadsheet-ID workflows. The
preferred next authorization improvement is Google Picker plus the recommended,
non-sensitive `drive.file` scope. That promotion must preserve the same broker,
proposal, and review contracts.

## Session state machine

```text
disconnected --Connect--> authorizing --success--> connected
      ^                          |                     |
      |                          +--deny/close/error---+
      |                                                |
      +--------------Revoke----------------------------+
                                                       |
connected --final 30 seconds / 401--> expired --click--+
```

- Popup closure, popup blocking, denial, partial grants, malformed tokens, and
  timeouts return typed errors without replacing an existing valid session.
- A successful reauthorization invalidates any pending spreadsheet proposal and
  requires a new range read, because the Google account may have changed.
- The credential provider never opens a popup. If called after expiry it fails
  before a connector request and asks the UI to obtain a new user gesture.
- **Revoke Google access** clears the local token before calling Google's revoke
  endpoint. Revocation removes all scopes granted to this OAuth app. A failed
  revocation remains locally disconnected and tells the user to check Google
  Account permissions.
- An uncertain spreadsheet write is still uncertain; obtaining a new OAuth
  token does not make it safe to retry the same proposal.

## CSP and popup requirements

The production CSP allowlists only Google's documented GIS parents:

- `script-src https://accounts.google.com/gsi/client`
- `connect-src https://accounts.google.com/gsi/`
- `frame-src https://accounts.google.com/gsi/`
- `style-src https://accounts.google.com/gsi/style`

Local dev and preview use `Cross-Origin-Opener-Policy:
same-origin-allow-popups`, as required for popup communication when FedCM is not
available. GitHub Pages uses the hosting platform's response headers.

The GIS library is loaded only after **Connect Google Sheets**. Connector,
planner, sandbox, audit, proposal, and workspace objects never receive the token.

## Current limitation

The token model authorizes API access but this slice does not request additional
profile or email scopes. The user chooses the account in Google's popup and can
use **Switch Google account**, but the operator does not yet display an email
address. Before organization policy grants or unattended execution, WasmHatch
must add a separately reviewed identity display without sending identity data to
the model or scripts.
