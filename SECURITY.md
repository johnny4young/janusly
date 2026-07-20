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

CI runs `pnpm audit --audit-level moderate` on every push and pull request.
The repository currently carries no ignored advisory. If an upstream-locked
finding ever requires a temporary exception, it must be documented here with
the parent chain, why the vector does not apply, a removal condition, and a
review date before it is added to `pnpm-workspace.yaml`.
