# Credit Insurance Request Management

A two-tier web application for managing credit-insurance requests from business submission through COFACE decision. The frontend calls a Node.js API, which persists data in SQLite.

## Run locally

From this folder, start the application:

```powershell
npm start
```

Then open `http://localhost:4173`. Use Admin settings to configure statuses, document requirements, roles and reminder rules. Data is stored in `data/creditflow.db`, and uploaded documents in `data/documents/`.

For a one-command Windows start, run `start-local.ps1`. For container and Microsoft Azure deployment, see `DEPLOYMENT.md`.

## Included in this MVP

- Operational dashboard and priority queue
- Searchable request register
- New-request form with configurable document checklist and PDF upload (max 10 MB)
- Request details with uploaded documents, download links and newer-version uploads
- Conversation thread on each request between the requester and Finance
- Activity timeline recording who did what and when
- Requester response to "Documents / Information Required" that returns the request to Finance
- Finance ownership ("Assign to me") so follow-ups reach the responsible reviewer
- Status transitions with COFACE reference and approved limit captured on approval
- Due dates driven by each stage's SLA (working days) and overdue reminders
- Export of the request register to Excel (CSV)
- Admin-managed workflow statuses and SLA targets
- Admin-managed documents, roles and reminders
- In-app notifications for new requests and workflow-stage changes
- Automatic reminders for requests pending without action for more than three days
- Responsive layout
- REST API with server-side validation
- SQLite persistence with WAL mode and indexed operational fields

## API

- `GET /api/health`
- `GET /api/session`
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `GET /api/bootstrap`
- `POST /api/requests`
- `GET /api/requests/export.csv`
- `GET /api/requests/:id`
- `POST /api/requests/:id/comments`
- `POST /api/requests/:id/documents?doc=:index`
- `GET /api/documents/:id`
- `POST /api/requests/:id/respond`
- `POST /api/requests/:id/assign`
- `PATCH /api/requests/:id/status`
- `PUT /api/config/:section`

See `REVIEW-NOTES.md` for access rules and validation on each endpoint.

Before corporate production deployment, add Microsoft Entra authentication, authorization middleware, managed cloud database hosting, encrypted document storage and Microsoft Graph notifications.
