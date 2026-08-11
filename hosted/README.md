# Credit Insurance Request Management

Hosted walkthrough application with Supabase authentication, PostgreSQL persistence, private PDF storage, row-level security, workflow notifications, reminders and audit events.

## Demonstration scope

- Self-registration, email confirmation, sign-in and sign-out
- Empty request register until a user submits data
- PDF-only document upload, maximum 10 MB per file
- Configurable workflow stages, document checklist, roles and reminder rules
- In-app notifications for submission, stage changes and requests pending more than three days
- Role-based request visibility and administration
- Private document access through short-lived signed links

Use only invented buyer information and dummy PDFs until the hosting and data-processing model has been approved by the company.

## Email limitation

Supabase Auth can send registration confirmation and password-recovery emails. Workflow emails require an authorized sender. Connect either Microsoft Graph with company consent or an approved SMTP/transactional email provider. The application does not contain or expose sender credentials.

## Production controls still owned by corporate IT

Microsoft Entra ID single sign-on, conditional access, production domain restriction, data residency approval, retention and deletion rules, malware scanning, key-management requirements, SIEM export, backups, incident response, penetration testing and supplier risk approval.
