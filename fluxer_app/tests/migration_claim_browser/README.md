# Migration claim browser acceptance

Run `pnpm --filter fluxer_app test:migration-claim-browser` with Playwright Chromium
installed. To use an installed Edge in a separate **headless** context on Windows:

```powershell
$env:FLUXER_CLAIM_BROWSER_CHANNEL = 'msedge'
pnpm --filter fluxer_app test:migration-claim-browser
```

The small Rspack entry compiles the real claim page, bootstrap, transport, controller,
auth card, form controls, birth-date controls, consent and Lingui macros. Only environment
stores, the preselected synthetic runtime gate, ordinary navigation and external-link handling
are substituted. Actual runtime selection is verified by the separate auth-target suites. A loopback-only
HTTP server and synthetic API responses keep this entirely separate from live accounts.
No desktop interaction, credentials, email delivery or production writes are involved.

Checks cover desktop/mobile widths, keyboard activation of ownership, submit, consent and
desktop date-option controls without pointer input, startup
URL cleanup, read-only identity, date selection, consent, completion returning to normal
sign-in, consent-text clipping, pagehide disposal, the authenticated private-window guard,
and fail-closed startup when URL cleanup fails.
Screenshots and the disposable build go in ignored `artifacts/migration-claim-browser/`.

This is not full application startup, real-session persistence, native API/database/cache
acceptance, actual email delivery or private Discord delivery. Those remain separate gates.
