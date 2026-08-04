# Credit Insurance Request Management

A two-tier web application for managing credit-insurance requests from business submission through COFACE decision. The frontend calls a Node.js API, which persists data in SQLite.

## Run locally

From this folder, start the application:

```powershell
npm start
```

Then open `http://localhost:4173`. Use Admin settings to configure statuses, document requirements, roles and reminder rules. Data is stored in `data/creditflow.db`.

For a one-command Windows start, run `start-local.ps1`. For container and Microsoft Azure deployment, see `DEPLOYMENT.md`.

## Included in this MVP

- Operational dashboard and priority queue
- Searchable request register
- New-request form with configurable document checklist
- Request details, document status and activity history
- Status transitions
- Admin-managed workflow statuses and SLA targets
- Admin-managed documents, roles and reminders
- Responsive layout
- REST API with server-side validation
- SQLite persistence with WAL mode and indexed operational fields

## API

- `GET /api/health`
- `GET /api/session`
- `GET /api/bootstrap`
- `POST /api/requests`
- `PATCH /api/requests/:id/status`
- `PUT /api/config/:section`

Before corporate production deployment, add Microsoft Entra authentication, authorization middleware, managed cloud database hosting, encrypted document storage and Microsoft Graph notifications.
