# Run moderated usability sessions

Use this guide to test whether a new operator can understand and act on a
failed native workflow. Automated accessibility and browser tests are readiness
checks, **not** evidence that a person can complete the journey.

## Prepare the session

1. Recruit three people who have not used Janusly. Record their operating role
   and prior workflow-tool experience under pseudonymous IDs; do not put names,
   contact details, customer payloads, recordings, or secrets in Git. Record
   whether a participant also joined a separate [incident interview](customer-discovery.md).
2. Obtain consent for observation and for any optional recording. Agree on
   retention and deletion with the study owner before collecting notes. A
   refusal to record must not exclude participation.
3. Use one clean, provider-free environment with a failed native workflow and
   no live external write target. Preload the same starting state for each
   participant. Verify the production build and relevant automated journeys:

   ```bash
   cd web
   pnpm --ignore-workspace build
   pnpm --ignore-workspace test:accessibility
   pnpm --ignore-workspace test:e2e
   ```

   The browser-only commands start Vite but require a separate, seeded API/PG18
   stack for live journeys; see [development](development.md). For an isolated
   real-Go/PG18 preflight, use `make test-e2e` from the repository root. These
   checks do not replace the moderated session.
4. Set up the environment, account and any download **before** starting the
   task clock. Note setup time separately. Do not teach the recovery path or
   reveal where the next control is.

## Give the participant one task

> A workflow has failed. Find the failure, explain what happened, choose a safe
> next step, and show what evidence would tell you whether recovery worked. Do
> not send a live write or supply a real credential.

Start the clock when the participant begins from Home. Stop when they can show
all four outcomes—failure, explanation, safe next step, and outcome evidence—or
when they stop. The experimental target is **three new users each completing
within ten minutes without moderator navigation help**; record actual elapsed
time and assistance rather than rounding a near miss into a pass. A sandbox
validation is not production verification. If the interface appears to offer an unsafe live action, stop
that action, record the problem, and keep the environment provider-free.

The moderator may ask “What are you looking for?” but must not name controls,
provide navigation hints, or click for the participant. If rescue is needed,
record the timestamp and exact prompt, then mark the attempt assisted. Ask for
confidence and the participant's interpretation of attempted versus verified
outcomes only **after** the task.

## Record a comparable result

Store one private, pseudonymous record per participant under the ignored
`output/review/` tree, subject to the agreed retention policy. Include:

| Field | What to record |
| --- | --- |
| Session | Pseudonym, date, role, prior tool experience, environment/build SHA, locale, consent/recording choice. |
| Outcome | Each of the four outcomes shown, independent/assisted/incomplete, elapsed task seconds, setup seconds separately. |
| Friction | Wrong destinations, dead ends, misleading copy, focus loss, assistance prompt and timestamp. |
| Interpretation | What the participant believes was attempted, validated, and independently verified; confidence after the task. |
| Accessibility | Input method, screen-reader/zoom settings when used, blocker and exact step; do not infer physical accessibility from an automated axe pass. |
| Safety | Any apparent live-write, credential request, tenant leakage, or unclear approval boundary; stop and escalate before reuse. |

Run a separate physical screen-reader and 200% zoom pass with consent and the
same task. Record device, OS, browser, assistive technology and version,
viewport, focus/announcement sequence, and whether recovery remains possible.
A participant may contribute to both studies, but an automated run, a demo by
staff, or an interview without task observation counts toward neither the
three-user task target nor physical accessibility acceptance.

Review the three records together. Report the denominator, individual times,
assistance and blockers; do not publish a success rate from incomplete records.
Prioritize safety and failed completion before visual preferences. Retest any
changed flow with an equivalent fresh task rather than editing the original
observations. The study owner decides whether the experimental target was met;
this guide by itself does not mark the product ready for a pilot.
