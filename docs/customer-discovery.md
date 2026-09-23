# Interview operators about workflow incidents

Use this guide for the five incident interviews in the deep-review discovery
plan. Its purpose is to test whether Janusly's native failure-to-evidence flow
solves a recurring, valuable problem—not to collect endorsements for a feature
list. The [moderated usability task](usability-testing.md) is a separate study.

## Recruit and protect the evidence

1. Recruit five people who own or respond to failures in business-critical
   workflows. Start with one workflow class and record role, team size,
   incumbent tools, and whether each person operates or buys the solution.
   Keep non-matching contacts as such; do not silently count them toward five.
2. Ask for one recent, specific incident. If the person cannot recall one,
   record “no qualifying incident” rather than asking them to invent one.
   Invite a **redacted** timeline or screen only if they choose to share it.
   Never request production access, API keys, customer records, or raw logs.
3. Obtain consent, explain note/recording retention, use pseudonymous IDs, and
   keep contact data and free-form notes outside Git under the study owner's
   policy. Store only redacted summaries in ignored `output/review/` if local
   evidence is needed. Recording is optional.

## Ask for a chronological incident, not opinions first

Keep the same core questions and log verbatim facts separately from
interpretations. Avoid showing a demo until the incident story is complete.

1. What workflow failed? What outcome should it have produced, and when was
   the failure first observable?
2. How did anyone detect it? Who was paged or noticed it, and how long after
   the actual failure?
3. Walk through diagnosis: which tools, evidence, handoffs and decisions were
   required? Which step consumed the most time?
4. What did you attempt to fix or replay? What could have been duplicated,
   charged, sent, lost or left ambiguous? What actually happened?
5. Who authorized the next action? What evidence convinced you the outcome was
   correct, rather than merely that a request was sent?
6. What did the incident cost in staff time, customer impact or risk? Ask for
   observed ranges and source; mark estimates and unknowns as such.
7. Why did the incumbent workflow/incident tools not resolve it? What would
   make switching or adding a tool too costly?
8. Who owns the budget and procurement/security review? What event would
   justify an evaluation, and what evidence would make it a no-go?

Only after these questions, show the provider-free native recovery demo. Ask
what is useful, misleading or missing; whether the person would run a bounded
trial; and which alternative they would use instead. Do not treat politeness,
feature enthusiasm or a hypothetical price answer as willingness to pay.

## Summarize and decide

For each interview, record: pseudonymous role; workflow class; incident date
range; detection, diagnosis, decision and verification times (measured,
estimated or unknown); actual versus possible duplicate effects; current
alternative; purchase authority; direct quotes only with consent; evidence
quality; and explicit next step or refusal. Keep the raw record private.

After five **qualifying** interviews, make a matrix by recurring incident
pattern, unresolved cost, incumbent workaround, buyer and evaluation trigger.
Separate observed facts, participant estimates and team hypotheses. Report
negative cases and missing data, not just favorable stories. Select **at most
two** potential design partners only if a repeated, costly native-workflow
problem and an owner willing to test it are both evidenced. If not, pause new
horizontal features and revisit the segment.

Before any partner pilot, write a separate agreement naming one workflow,
environment, tenant, data/credential handling, permitted effects, human
approver, independent outcome check, stop conditions, and success threshold.
Begin with observation/validation. A live external write, credential handoff,
production deployment or spend needs its own explicit approval; this guide
cannot authorize one. Measure actual detection-to-verification time and
observed duplicate effects, but do not claim universal exactly-once behavior
from a small sample.
