# Usability testing

Moderated usability evidence belongs under the ignored `output/review` tree and
must never be committed. Use pseudonymous participant identifiers and obtain
appropriate consent before recording observations.

The supported automated readiness check is the Playwright suite in `/web`.
Before a session, run the production build and the relevant accessibility and
browser journeys:

```bash
cd web
pnpm --ignore-workspace test:accessibility
pnpm --ignore-workspace test:e2e
```

For full single-runtime validation, use `make test-e2e`. Automated coverage
proves that task affordances and accessibility checks work; it is not a
substitute for moderated human evidence.

A study should cover workflow creation, failed-run discovery, recovery, adding
a connection, and inviting a teammate. Record completion, elapsed time, wrong
destinations, assistance, and confidence with a fixed rubric. Keep free-form
notes outside the repository according to the study's retention policy.
