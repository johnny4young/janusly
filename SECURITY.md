# Security policy

## Reporting a vulnerability

If you discover a security issue in Janusly, please email
**security@janusly.com** with a description, a minimal reproducer, and your
assessment of impact and severity. We aim to acknowledge reports within two
business days and to have a fix or mitigation in place for `high` and
`critical` issues within thirty days.

Please do not open a public GitHub issue for security-sensitive reports. Use
the email address above so we can coordinate disclosure responsibly.

## Supported branches

Security fixes ship on the default branch (`main`). Older branches are not
maintained.

## Dependency scanning

CI runs `pnpm audit --audit-level moderate` for `/web` and
`go tool govulncheck ./...` for the Go runtime on every push and pull request.
The repository carries no ignored advisory. A temporary exception must be
documented here with the dependency chain, applicability analysis, removal
condition, and review date.
