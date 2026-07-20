# Changelog

Notable user-facing and operational changes are recorded here. Janusly has not
published a versioned release yet; entries remain under **Unreleased** until the
first release tag is cut.

## [Unreleased]

### Added

- End-to-end recovery operations: failure diagnosis, alternative patches,
  sandbox validation, production redrive, rollback, and evidence-gated
  Recovery Playbooks with success scorecards.
- Recovery containment through transient retries, workflow circuit breaking,
  buffered trigger backfill, durable queue publication, and stalled-node repair.
- Operations surfaces for recovery metrics, workflow health and SLOs, alerts,
  queue and rate-limiter degradation, costs, audit logs, and run evidence.
- Enterprise identity and authorization with SSO, SCIM directory sync, custom
  roles, and a closed permission catalog.
- Versioned API contracts with generated OpenAPI 3.1 output plus typed Node and
  Python SDKs.
- Workflow organization, reusable snippets, solution packs, event-driven
  triggers, bounded loop execution, integration tools, MCP client/server
  support, and operator-guided AI generation.
- English and Spanish web localization, accessibility checks, onboarding, and
  responsive navigation for the operator UI.

### Changed

- Runtime support is verified on Node.js 22.12 and 24, with Postgres 15 as the
  compatibility floor and Postgres 18 as the baseline.
- LLM completions use a provider-neutral client while the supported production
  posture remains Anthropic-only; every AI path preserves deterministic
  fallback behavior.
- Public documentation now describes shipped behavior directly instead of
  depending on private planning records.

### Security

- Strengthened tenant scoping, audit transaction boundaries, outbound HTTP
  SSRF and DNS-rebinding defenses, MCP write consent, secret scrubbing, memory
  consent and retention, and human-resume token validation.

The current release-candidate baseline incorporates the platform-hardening work
merged in [pull request #18](https://github.com/johnny4young/janusly/pull/18).
