# Security Policy

## Project status

MetOrigin Splat is Alpha software. No public binary release or supported offline installer is currently available. Security fixes are applied to the latest `main` branch and may be included in future Alpha source tags.

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue, pull request, discussion, screenshot, or log attachment.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/metorigin/MetOrigin-Splat/security/advisories/new>

If private vulnerability reporting is temporarily unavailable, open a public issue containing no vulnerability or exploit details and ask the maintainers to establish a private contact channel.

Include, where possible:

- Affected commit, branch, or version
- Operating system and hardware details
- A concise description of the impact
- Reproduction steps or a minimal proof of concept
- Whether user interaction or a malicious project/media file is required
- Suggested remediation, if known

Remove credentials, private media, personal filesystem paths, and unrelated log content before sending a report.

## Areas of particular interest

Reports are especially useful when they involve:

- Arbitrary command execution or unsafe Tauri capability exposure
- Path traversal, symlink escape, or deletion outside a validated project directory
- Malicious project, archive, media, PLY, JSON, or SQLite input handling
- Engine binary substitution, checksum bypass, or unsafe executable discovery
- Sensitive information written to diagnostics, logs, recent-project state, or exported archives
- Installer, update, signing, or dependency supply-chain issues
- Denial of service with a practical impact beyond expected processing cost

## Disclosure process

Maintainers will assess reports on a best-effort basis, coordinate remediation privately when appropriate, and credit reporters who request attribution. Please allow a reasonable remediation period before public disclosure.

This policy does not authorize accessing other people's data, disrupting services, or testing systems without permission.
