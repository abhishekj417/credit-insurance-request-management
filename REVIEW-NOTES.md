# Review notes: collaboration features (after the security assessment)

These changes move Finance ↔ business communication on credit insurance requests out of email and into the application. They are built **on top of** the security remediation branch (`security/assessment-fixes`). That branch is unchanged and remains the version for the assessment re-test.

## How to review only what changed

- Compare view (everything new since the assessed fixes):
  `https://github.com/abhishekj417/credit-insurance-request-management/compare/security/assessment-fixes...feature/finance-business-collaboration`
- Or locally: `git diff security/assessment-fixes..feature/finance-business-collaboration`
- Each feature is a separate commit with its own description and tests, so it can be reviewed one at a time.

**Scope of the change:** about 700 lines across `server.js`, `app.js`, `styles.css` and tests, plus this document and the README / deployment guide.

**Not touched:**
- no new npm dependencies (still none in the root app);
- no changes to `hosted/`, `Dockerfile`, `compose.yaml` or `.env.example`;
- no changes to authentication, the static-file allowlist, rate limiting or security headers.

## Commits

| Commit | Purpose | New / changed endpoints |
|---|---|---|
| `d0831e4` | Conversation thread on each request; activity timeline records who did what and when | `GET /api/requests/:id`, `POST /api/requests/:id/comments` |
| `fa047b3` | Documents are actually uploaded and stored (previously only a "file chosen" flag) | `POST /api/requests/:id/documents?doc=N`, `GET /api/documents/:id` |
| `ce1d4b2` | Requester answers a "Documents/Information Required" request and sends it back | `POST /api/requests/:id/respond` |
| `b2619ee` | COFACE reference and approved limit captured; required to approve | `PATCH /api/requests/:id/status` (two optional fields added) |
| `677bb9e` | Finance reviewer can take ownership; follow-ups go to that person | `POST /api/requests/:id/assign` |
| `f944085` | Due dates follow each stage's SLA (working days); overdue reminders | none |
| `bc54c54` | Admin configuration validated; CSV export of the register | `PUT /api/config/:section` (validation only), `GET /api/requests/export.csv` |
| `14903f3` | Inline styles moved to the stylesheet (they were blocked by the CSP) | none |

## Access rules for the new endpoints

All endpoints sit behind the same authentication as before (`AUTH_MODE=entra` by default) and the same per-user rate limits. "Can see the request" uses the rule introduced for finding 31283876:
- Finance Reviewers and Administrators can see every request;
- everyone else can see only requests they submitted.

Requests a caller cannot see return **404**, the same as requests that do not exist, so IDs cannot be probed.

| Endpoint | Who may call it | Validation / limits | Audit event |
|---|---|---|---|
| `GET /api/requests/:id` | Anyone who can see the request | — | — |
| `POST /api/requests/:id/comments` | Anyone who can see the request | 1–2000 characters | `request.comment` |
| `POST /api/requests/:id/documents` | Anyone who can see the request | `Content-Type: application/pdf` (else 415); body must start with `%PDF-` (else 400); max 10 MB (else 413); valid checklist index; file name sanitised | `document.upload` |
| `GET /api/documents/:id` | Anyone who can see the parent request | Sent as an attachment with `Content-Security-Policy: sandbox` and `nosniff` | `document.download` |
| `POST /api/requests/:id/respond` | Only the request's own requester | Only while status is "…Documents Required" / "…Information Required" (else 409); required documents must be uploaded first | `request.respond` |
| `POST /api/requests/:id/assign` | Finance Reviewer, Administrator | Release only by the assignee or an Administrator | `request.assign` |
| `PATCH /api/requests/:id/status` | Finance Reviewer, Administrator (unchanged) | `cofaceReference` ≤ 100 chars; "Approved" requires `approvedAmount` > 0 and a reference | `request.status_change` (now includes outcome) |
| `PUT /api/config/:section` | Administrator (unchanged) | See "Configuration validation" below | `config.update` |
| `GET /api/requests/export.csv` | Any signed-in user; contains only requests they can see | Cells beginning with `= + - @`, tab or CR are prefixed with `'` (CSV/formula injection); sent with `sandbox` CSP | `request.export` |

All new values rendered in the browser pass through the existing `esc()` HTML-escaping helper. A test fails if any raw value is interpolated into `innerHTML`.

## Data changes

Additive only. Existing data is preserved, and new tables and columns are created on start-up if missing.

| Object | Purpose |
|---|---|
| `request_events` table | Activity timeline and comments: request, time, actor, type, message |
| `request_documents` table | Metadata for each uploaded file: original (sanitised) name, random stored name, size, uploader, time |
| `requests.return_status` column | Stage to return to when the requester responds |
| `<data dir>/documents/` folder | Uploaded PDFs, stored under random UUID file names. Not reachable through the static-file server (allowlist). Lives on the same volume as the database (`/app/data` in the container). |

## Configuration validation (`PUT /api/config/:section`)

- **All sections:** 1–50 items; names trimmed, required and unique; unknown fields are dropped.
- **Statuses:**
  - colour must be from the fixed list, and SLA 0–90 days;
  - `Approved`, `Rejected` and `Closed` must remain;
  - a stage that any request is currently in cannot be removed or renamed (409).
- **Documents:** checklist positions that already have uploads must keep the same document (409). This prevents uploaded files being re-labelled as a different document type.
- **Roles:** access must be one of the defined levels.
- **Reminders:** delay 1–365 days.

## Tests

Run `npm test`. That covers 34 tests:
- `tests/api.test.js` (existing, with one test updated to send the now-required COFACE fields);
- `tests/security.test.js` (security findings, plus an overdue-reminder test);
- `tests/collaboration.test.js` (new).

The new tests cover each access rule above, including negative cases:
- another requester, unauthenticated, and wrong role;
- invalid, oversized and non-PDF uploads;
- file-name sanitisation;
- CSV formula injection;
- configuration guards.

## Known limitations / items for IT

- **Email or Teams alerts are not included.** Notifications remain in-app. Sending "you have an action" alerts with a link requires an approved sender (Microsoft Graph or Power Automate) and IT consent.
- **Uploads are not malware-scanned** by the application. Only PDFs are accepted and they are always downloaded as attachments. If scanning is required, it should be applied to the `documents` folder or at the proxy.
- **Backups:** the `data` directory now contains both the database and the documents, and must be backed up as one unit.
- **Documents cannot be deleted** through the application. A newer version can be uploaded alongside the old one, and both are kept as a record.
- **Reminder rules in Admin are not yet used.** They are validated but remain informational. Reminders are driven by:
  - the fixed 3-day inactivity rule (unchanged);
  - the new SLA-based overdue rule.
