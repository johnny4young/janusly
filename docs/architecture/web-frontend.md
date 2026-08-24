# Web frontend

The React 19 application lives in `/web` as a standalone pnpm project. It uses
Vite, TypeScript, Tailwind CSS, Vitest, and Playwright.

Production requests are same-origin. The Go executable serves the embedded
bundle with SPA fallback, one-year immutable caching for hashed `/assets/`, and
`no-cache` for the HTML shell and top-level files. Vite proxies API paths to
`127.0.0.1:3001` during development.

The Go browser boundary applies the CORS allowlist and defense-in-depth browser
headers to API, SPA, and public responses: CSP, frame denial, MIME sniffing
prevention, a bounded permissions policy, and a referrer policy. New browser
methods must also be added to the explicit preflight method list.

The application has one i18n boundary under `web/src/i18n`, one workflow store,
and error boundaries around major workspaces. Accessibility, localization,
browser behavior, bundle budgets, and zero-console-error E2E are acceptance
requirements.

Do not add a second frontend project, root package workspace, production API URL
setting, or separate production web process.
