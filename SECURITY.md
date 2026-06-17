# Security Policy

## Supported Versions

This project is intended for internal network deployments. Security fixes are expected to target the latest public version only.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older versions | Best effort |

## Reporting a Vulnerability

Please report suspected security issues privately instead of opening a public GitHub issue.

Contact:

- Wesley Van Hamme
- wesley.van.hamme@mondzorgzuid.be

Include as much detail as possible:

- affected version
- affected component: server, client, admin, updater, installer, or build script
- reproduction steps
- expected impact
- logs or screenshots with sensitive data removed

## Deployment Assumptions

Kabinette Notes is designed for trusted internal environments such as LAN or VPN-connected workstations. It is not intended to be exposed directly to the public internet.

Use of this software is at your own risk. To the maximum extent permitted by applicable law, including European Union law and national EU/EEA Member State law, Wesley Van Hamme is not responsible or liable for damages, data loss, security incidents, downtime, misconfiguration, unauthorized access, failed updates, business interruption, loss of profits, or any other consequences resulting from installing, modifying, distributing, deploying, or using this software.

Nothing in this security policy or license is intended to exclude liability where such exclusion is not allowed under mandatory applicable law.

Recommended baseline:

- keep the server on a trusted internal network or VPN
- use `KABINETTE_TOKEN` for networked deployments
- restrict inbound firewall access to trusted clients/admin machines
- use TLS through a reverse proxy when traffic crosses untrusted networks
- keep server state backups protected
- treat notes and chat history as sensitive internal data

## Update Security

The client update flow can download and install a newer client installer from the configured server.

Recommended:

- host update files only on a trusted internal server
- restrict update endpoints to trusted networks
- keep `.version`, `.blockmap`, and installer files together
- code-sign Windows installers before broad deployment
- validate update behavior in a test environment before production rollout

## Secrets And Tokens

Do not commit real tokens, internal IPs, VPN hostnames, customer/patient data, or production configuration files.

The build GUI can generate deployment helper files in `dist/`. Review these files before sharing builds or publishing artifacts.

## Privacy And GDPR

The deployer is responsible for privacy and data-protection compliance, including GDPR where applicable. The author does not operate the deployment, receive deployment data, or act as a data processor unless separately agreed in writing.

Review `PRIVACY.md` before using the software with personal data, customer data, patient data, employee data, or other regulated data.

## Not A Security Boundary

The admin/client distinction is an application workflow boundary, not a strong security boundary by itself. Use network controls and `KABINETTE_TOKEN` for access control.

## Out Of Scope

The following are usually not treated as security vulnerabilities unless they lead to a real exploit:

- missing public internet hardening for a deployment that intentionally exposed the server
- outdated local development dependencies without an exploitable path
- issues requiring local administrator access on the same Windows machine
- screenshots or examples that use sanitized demo data
