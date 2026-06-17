# Privacy And Data Protection

Kabinette Notes is self-hosted software. The project author does not operate the server, receive user data, process deployment data, or provide hosted infrastructure.

## Data Controller Responsibility

The person or organization deploying Kabinette Notes is responsible for determining whether personal data is processed and for complying with applicable privacy and data-protection laws, including GDPR where applicable.

The deployer is responsible for:

- deciding what may be written in notes and chat
- informing users where required
- controlling access to the server and admin app
- setting authentication tokens
- securing backups
- defining data-retention rules
- deleting data when required
- handling data-subject requests where applicable
- assessing whether a DPIA, internal policy, or legal review is needed

## Data Stored By The App

Depending on use, the app can store:

- computer names
- Windows user names
- shared notes
- local chat history
- queued chat messages
- server connection settings
- update logs
- server state

On Windows clients, local data is stored under:

```text
%ProgramData%\KabinetteNotes\
```

The server state file defaults to:

```text
kabinette-server-state.json
```

## Sensitive Data

Do not store unnecessary sensitive data in notes or chat. Avoid storing patient, customer, financial, medical, or other regulated data unless your organization has reviewed and approved that use.

## Security Measures

Recommended minimum measures:

- keep the server on LAN or VPN
- use `KABINETTE_TOKEN`
- restrict inbound firewall access
- protect server state backups
- use TLS through a reverse proxy when traffic crosses untrusted networks
- code-sign installers for broad deployment
- keep deployment files and update files on trusted infrastructure

## No Hosted Processing By The Author

Unless you separately agree otherwise in writing, Wesley Van Hamme does not act as a processor, sub-processor, hosting provider, support provider, or data recipient for deployments of this software.
