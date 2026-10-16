# Deployment guide

## Deployment options

### Controlled local pilot

Requirements: Windows computer or server with Node.js 22.5 or later.

1. Copy this folder to the approved computer.
2. Run `start-local.ps1`.
3. Open `http://localhost:4173`.
4. Back up the `data` directory regularly.

This mode is suitable only for a limited pilot on an approved device. `start-local.ps1` sets `AUTH_MODE=development`, which disables sign-in and grants every role, so never use it on a shared server. The server refuses to start in development mode when `NODE_ENV=production`.

### Container deployment

Requirements: Docker Desktop or an approved container host.

1. Run `docker compose up -d --build`.
2. Open `http://server-name:4173`.
3. Back up the named `credit-insurance-data` volume.

For corporate use, place the service behind HTTPS and a company reverse proxy. Do not expose port 4173 directly to the public internet.

### Microsoft Azure deployment

1. Deploy the container to Azure App Service.
2. Enable App Service Authentication with Microsoft Entra ID and require authentication.
3. Set `AUTH_MODE=entra`.
4. Define Entra application roles named `Business Requester`, `Finance Reviewer`, and `Administrator`.
5. Assign the corresponding corporate groups to those roles.
6. Mount persistent storage or replace SQLite with Azure SQL before broad rollout.
7. Set `FRAME_ANCESTORS` to approved SharePoint or Teams origins only if the application will be embedded.
8. Enable HTTPS-only, application logging, monitoring and backups.

## Identity and permissions

`AUTH_MODE` defaults to `entra`. In development mode, the local user receives all roles so that the complete workflow can be tested. In Entra mode, the API requires identity headers supplied by Azure App Service Authentication and enforces application roles:

- `Business Requester`: create requests
- `Finance Reviewer`: update workflow status
- `Administrator`: update status and configuration

The server, not the browser, records the authenticated requester identity.

## Security controls

- Only `index.html`, `styles.css` and `app.js` are served as static files; all other paths return 404.
- Per-user rate limits (default 300 reads and 30 writes per minute, configurable with `RATE_LIMIT_READS` / `RATE_LIMIT_WRITES`) return HTTP 429 when exceeded. Reminder scans run at most once every five minutes.
- Authentication failures, authorization denials, rate-limit blocks and every write (request creation, status change, configuration change, notification read) are written as JSON lines to stdout and to the `audit_events` table. Forward container stdout to the central log store / SIEM.
- API responses send `X-Content-Type-Options: nosniff`, a restrictive Content-Security-Policy, and HSTS on HTTPS requests. Configure HSTS at the TLS-terminating proxy as well.
- The browser escapes all server-supplied values before rendering them.

## Production readiness checklist

- Corporate DNS name and TLS certificate
- Microsoft Entra authentication enabled
- Entra groups mapped to application roles
- Azure SQL migration for multi-user production scale
- SharePoint or Blob Storage for actual documents
- Microsoft Graph approval for email notifications
- Automated database and document backups
- Central application logs and alerting
- Retention, privacy and security review
- User acceptance testing in a non-production environment
- Named service owner and support process

Microsoft 365 permissions and intranet publication require a corporate administrator. The application package reduces that work to configuration and approval; it cannot safely eliminate those controls.
