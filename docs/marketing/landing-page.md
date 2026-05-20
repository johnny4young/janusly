# Janusly landing-page content pack

The canonical landing-page **design brief + copy pack** for the Janusly website. The downstream consumer is **Claude Design** (a generative-design tool) plus any web dev that hand-builds the page. This document carries everything that surface needs: navigation, hero variants, section copy, SEO metadata, alt-text, form labels, and tone/visual guidance.

**English is the source-of-truth.** The Spanish version (Section D) is a parallel translation aligned with the product UI's i18n catalog (`apps/web/src/i18n/locales/es/common.json`) where product terms already exist. When the two diverge, English wins and Spanish is updated.

**Voice anchor:** every line follows the rules in [`docs/marketing/narrative.md`](narrative.md) — concrete over abstract, honest about today vs destination, engineering reality as proof, never "AI fixes everything", MTTR as the metric of record.

**Strategy anchor:** every claim traces back to [`docs/PLAN.md` §16.0](../PLAN.md) and the README. The README hero is the model voice for the English variant.

**Segment anchor:** the three use-case cards mirror the three canonical segments in [`docs/marketing/icp.md`](icp.md). Pain quotes are lifted verbatim from that document.

---

## Section A — Block index + AC checklist

This table maps every required AC block to where it lives in this file (English heading | Spanish heading). All 8 AC requirements are covered.

| # | AC requirement | English block | Spanish block |
| --- | --- | --- | --- |
| 1 | Hero | C.1 Hero | D.1 Hero |
| 2 | Subcopy | C.1 Hero (subhead inside the hero block) | D.1 Hero (subhead) |
| 3 | CTAs | C.1 Hero (primary + secondary CTAs) + C.8 Final CTA | D.1 + D.8 |
| 4 | Problem statement | C.2 Problem | D.2 Problema |
| 5 | "Janusly loop" diagram copy | C.3 The Janusly loop | D.3 El loop de Janusly |
| 6 | Security/control section | C.5 Security and control | D.5 Seguridad y control |
| 7 | Use cases | C.4 Use cases | D.4 Casos de uso |
| 8 | Technical buyer proof points | C.6 For technical teams | D.6 Para equipos técnicos |

Extras beyond the AC (for Claude Design consumption): Section B (page meta + nav + footer), C.7 / D.7 (MTTR metric callout), C.9 / D.9 (forms), C.10 / D.10 (visual style notes), Section E (translation + voice notes), Section F (Claude Design handoff notes).

---

## Section B — Page meta + navigation + footer (shared across languages)

### SEO metadata

**English:**

- `<title>` (~60 chars): `Janusly — the self-healing AI workflow operator`
- `<meta name="description">` (~155 chars): `Run AI workflows in production with the operational confidence of a database. Janusly observes every run, explains every failure, and reviews every fix.`
- `og:image` alt-text: `A calm operator dashboard showing a recovered workflow in green, with a recovery timeline visible.`
- Canonical URL slot: `https://janus.ly/` (or the live domain)

**Spanish:**

- `<title>` (~60 chars): `Janusly — el operador autoreparable de flujos con IA`
- `<meta name="description">` (~155 chars): `Corré flujos de IA en producción con la confianza operativa de una base de datos. Janusly observa cada corrida, explica cada falla y revisa cada arreglo.`
- `og:image` alt-text: `Un panel de operador en calma mostrando un flujo recuperado en verde, con la línea de tiempo de recuperación visible.`
- Canonical URL slot: `https://janus.ly/es` (or the live Spanish locale)

### Top navigation menu (5–7 items)

**English:**

| Order | Label | Destination intent | Notes |
| --- | --- | --- | --- |
| 1 | Product | Sub-menu | Sub-items: Recovery Center · AI workflows · Observability · Audit & rollback |
| 2 | Use cases | `#use-cases` anchor | Scrolls to the C.4 block |
| 3 | Pricing | `/pricing` | Out-of-scope here; ENG-068 ships the page |
| 4 | Docs | `https://docs.janus.ly` | Or wherever the docs deploy |
| 5 | Sign in | `/login` | Right-aligned, low-emphasis |
| 6 | **Get started** | `/signup` | Right-aligned, primary button styling |

**Spanish (orden idéntico):**

| Orden | Etiqueta | Destino |
| --- | --- | --- |
| 1 | Producto | Submenú: Centro de Recuperación · Flujos con IA · Observabilidad · Auditoría y rollback |
| 2 | Casos de uso | `#casos-de-uso` |
| 3 | Precios | `/es/precios` |
| 4 | Docs | `https://docs.janus.ly/es` |
| 5 | Iniciar sesión | `/login` |
| 6 | **Empezar** | `/signup` |

### Footer

**Link groups (English / Spanish in parallel):**

| Group | English items | Spanish items |
| --- | --- | --- |
| Product | Recovery Center · AI workflows · Integrations · MCP server · Changelog | Centro de Recuperación · Flujos con IA · Integraciones · Servidor MCP · Changelog |
| Resources | Docs · Demos · Recording scripts · Brand narrative · ICP | Docs · Demos · Guiones de grabación · Narrativa de marca · ICP |
| Company | About · Careers · Contact · Press kit | Sobre nosotros · Carreras · Contacto · Press kit |
| Legal | Terms · Privacy · Security · Data processing addendum (DPA) | Términos · Privacidad · Seguridad · Anexo de procesamiento de datos (DPA) |

**Social row (both languages):** X / Twitter, LinkedIn, GitHub. Icon-only; alt-text "Janusly on X", "Janusly on LinkedIn", "Janusly on GitHub" (Spanish: "Janusly en X", "Janusly en LinkedIn", "Janusly en GitHub").

**Brand-mark + tagline subline (footer strip):**

- English: `Janusly — AI workflows that explain, recover, and safely evolve.`
- Spanish: `Janusly — flujos con IA que explican, se recuperan y evolucionan con seguridad.`

**Copyright line:** `© 2026 Janusly. All rights reserved.` / `© 2026 Janusly. Todos los derechos reservados.`

---

## Section C — English copy

### C.1 Hero

**Eyebrow / kicker (line above the headline):**

- Canonical: `The operational backbone for AI workflows`
- Alt 1: `Production-ready AI workflows`
- Alt 2: `Run AI in production, not just in demos`

**Primary headline:**

- Canonical: `Janusly is the self-healing AI workflow operator.`
- Alt 1 (shorter, snappier): `AI workflows that explain, recover, and safely evolve.`
- Alt 2 (more aggressive): `Stop debugging AI workflows at 3am.`

**Subhead (2–3 sentences):**

- Canonical: `Every run is observable. Every failure is explainable. Every proposed fix is reviewable before it touches production. Run AI workflows with the operational confidence of running a database.`
- Alt 1 (problem-led): `Your AI demo works. Your AI workflow in production at 3am — that's a different story. Janusly is the layer between the two.`
- Alt 2 (outcome-led): `Cut Mean Time To Recovery for failed automations from hours to minutes. Observable, recoverable, reviewable, auditable.`

**Primary CTAs (2):**

| Order | Label | Intent |
| --- | --- | --- |
| 1 | `Watch the 3-minute recovery demo` | Plays the [`failed-workflow-recovery`](recording-scripts/failed-workflow-recovery.md) recording inline. |
| 2 | `Book a 15-minute demo` | Opens a Calendly or equivalent booking widget. |

**Secondary CTAs (2, lower visual weight):**

| Order | Label | Intent |
| --- | --- | --- |
| 1 | `Run locally` | Links to the Quick start section of the README / docs. |
| 2 | `Read the docs` | Links to the public docs. |

**Trust strip (under the CTAs, placeholder until ENG-093 ships real names):**

`Trusted by ops and engineering teams shipping AI to production.` (Once design partners are public, this becomes a logo strip.)

**Visual style note (for Claude Design):** Hero illustration should evoke **calm post-recovery confidence**, not a stressed engineer mid-crisis. Think "Postgres logo aesthetic": minimalist, trustworthy, technical. Avoid generative-AI tropes (no glowing brains, no holographic networks). Cobalt + Cyan from `apps/web/src/index.css`.

---

### C.2 Problem statement

3 paragraphs. Two opener variants for A/B testing.

**Opener — Variant A (3am scene):**

> Every company is racing to put AI into production. Most discover the same hard truth in week three: an LLM that works perfectly in a demo is a different animal at 3am, when it's running a billing flow and something upstream broke.

**Opener — Variant B (credential-rotated scene):**

> Your AI workflow worked perfectly in staging. It worked for two weeks in production. Then the credential rotated, the third-party API silently changed its contract, and your on-call engineer is reading log traces at 2am instead of sleeping.

**Common middle paragraph:**

> Workflow tools were built for the **integration era** — drag-and-drop connectors between APIs that already worked. They were not built for the **AI era**, where the hardest question is not "how do I wire these systems together?" but "what do I do when the model returns nonsense, the secret expired, or a step that worked yesterday fails today?"

**Common closing paragraph:**

> Janusly is the operational backbone for AI workflows. Every run is observable, every failure produces a structured explanation, every proposed fix is reviewable in a sandbox before it touches production, and every change can be replayed safely. The destination: a world where running an AI workflow in production carries the same operational confidence as running a database.

**Visual style note (Claude Design):** This block reads as prose, not bullets. Render in a comfortable reading column (≤600px wide). Pull-quote the "integration era / AI era" sentence into a callout if the design allows.

---

### C.3 The Janusly loop — diagram copy + caption set

This section pairs with a visual diagram of the 8-step loop (Prompt → DAG → Run → Observe → Explain → Patch → Replay → Learn). For each step: a short label, a caption sentence, screen-reader alt-text for the diagram node, and a supporting micro-fact (the engineering proof).

| # | Step label | Caption (≤16 words) | Diagram alt-text (≤8 words) | Micro-fact |
| --- | --- | --- | --- | --- |
| 1 | **Prompt** | Describe the workflow in natural language. Janusly drafts the DAG. | Operator types a workflow prompt. | `POST /ai/generate-workflow` with provider-neutral LLM client. |
| 2 | **DAG** | Edit the workflow on a visual canvas. Save versions automatically. | Workflow nodes connected on canvas. | `React Flow` canvas; `workflow_versions` table tracks history. |
| 3 | **Run** | Execute on a durable Postgres + BullMQ runtime. Retries, timeouts, multi-tenant scope. | Workflow run executing step by step. | Postgres-backed `runs` + `run_nodes` + `run_events`; SIGTERM-safe worker. |
| 4 | **Observe** | Every node lifecycle emits a structured event. Audit log records every action. | Timeline of node events. | `run_events` per node; OpenTelemetry `service.name="janusly"`; per-org `usage_events`. |
| 5 | **Explain** | When a node fails, AI translates the error envelope into a plain root cause. | AI summarizing a failure for the operator. | `POST /ai/explain-run`; failure-signature clustering groups similar DLQ rows. |
| 6 | **Patch** | AI proposes 1–3 alternative fixes with self-rated confidence. You review the diff before anything changes. | Operator reviewing patch options. | `POST /ai/patch-workflow`; config envelope (`swap_secret_ref`, `add_retry`, etc.) + structural envelope (`insert_approval_upstream`). |
| 7 | **Replay** | Sandbox-validate the patched workflow with write-side calls skipped. Save the new version. Replay the original run. | Sandbox run going green before save. | `replayMode: "validation"`; dryRun gate skips write-side; `workflow_versions` row created. |
| 8 | **Learn** | Every accept/reject teaches Janusly how your team prefers to recover. Suggestions adapt. | A feedback signal flowing back into the loop. | `recovery_feedback` table; `summarizePastFeedback` shapes future patch prompts. |

**Connecting narrative paragraph (≤4 sentences, sits under the diagram):**

> It's 3am. The billing flow has failed. You open Janusly: the failed run is at the top of the Recovery Queue, with a plain-English explanation of what broke. The AI proposes two fixes — one structural (insert an approval upstream), one config (swap the unbound secret). You review the diffs, validate in a sandbox, apply. The replay goes green. It's 3:04am. You go back to sleep.

**Visual style note (Claude Design):** This section can render as either a horizontal looping diagram (preferred — emphasises that "Learn" feeds back into "Prompt") or as a vertical step list with connecting lines. If the diagram is rendered, each step gets the alt-text above; if it's a list, the captions become bullet labels.

---

### C.4 Use cases (3 cards)

Three cards in a row (or stacked on mobile). Each anchored on one of the canonical ICP segments from [`icp.md`](icp.md). Pain quotes are lifted verbatim from icp.md's "Pain points (the buyer's own words)" sections.

#### Card 1 — Ops teams at B2B startups

- **Icon prompt for Claude Design:** `An invoice with a green checkmark, suggesting a refund processed cleanly.`
- **Header:** `Ops, finance, and customer-support workflows`
- **Pain quote (verbatim from icp.md Segment 1):** `"Billing exceptions wake me up. We process refunds in three places — Stripe, our admin tool, customer support — and they all disagree about which one is the source of truth."`
- **Outcome line:** `With Janusly: one workflow, one approval, one signed billing call, one audit row. The 3am page goes away.`
- **CTA:** `Watch the refund-triage demo →` (links to [`recording-scripts/refund-triage.md`](recording-scripts/refund-triage.md))

#### Card 2 — Engineering and support teams

- **Icon prompt for Claude Design:** `A shield with a clock inside, suggesting incident response handled in time.`
- **Header:** `Incident triage and escalation routing`
- **Pain quote (verbatim from icp.md Segment 2):** `"Every incident is the same triage: read the alert, find the affected service, file the GitHub issue, ping the on-call, paste the link in the right Slack channel. Fifteen minutes of toil per incident, and we have eight a week."`
- **Outcome line:** `With Janusly: the alert lands, AI summarizes, GitHub gets the issue, Slack pings the channel. Fifteen minutes back, eight times a week.`
- **CTA:** `Watch the incident-triage demo →` (links to [`recording-scripts/incident-triage.md`](recording-scripts/incident-triage.md))

#### Card 3 — AI builders and agencies

- **Icon prompt for Claude Design:** `Three small circles connected by lines, suggesting multi-agent orchestration or composable infrastructure.`
- **Header:** `Production runtime for client AI workflows`
- **Pain quote (verbatim from icp.md Segment 3):** `"I built a great agent demo for the client. Now they want to put it in production and I realized I have nothing — no runtime, no audit log, no way to roll back when the model misbehaves."`
- **Outcome line:** `With Janusly: durable runtime, audit log, version rollback, MCP client and server, multi-agent primitive. Six weeks of glue code per client becomes a configuration step.`
- **CTA:** `Explore the multi-agent demo →` (links to [`../demos/multi-agent-decision.md`](../demos/multi-agent-decision.md))

**Visual style note (Claude Design):** Each card has roughly equal height (pad the shorter pain quotes). Cards use the line-icon style (2px stroke, no gradients) for the segment icon. Pain quote is set in a subtle gray italic; outcome line is the body color.

---

### C.5 Security and control

A bullet list of 5–7 items. Every claim cites engineering reality (not "enterprise-grade", not "bank-level").

- **Multi-tenant scope on every query.** Every database query carries `eq(<table>.orgId, auth.orgId)`. No "shared org_id of 'default'" leak path. Verified by route-level tests.
- **Audit log: row per action.** Every workflow save, every run start, every approval decision, every recovery feedback — one row in `audit_logs` with the actor, action, target, and metadata. Year-end finance close becomes a single SELECT.
- **Secrets live in env, not the database.** The `credentials` row stores the env-var NAME only; the secret value never leaves the operator's vault. Tool errors never echo the env-var name back to the workflow output.
- **SSO via WorkOS, SCIM via WorkOS Directory Sync.** Enterprise SSO (SAML, OIDC) and SCIM provisioning are wired through WorkOS. Existing OAuth users keep their Supabase session; SSO is additive.
- **Sandbox-validate before save.** Every AI-proposed patch runs in a sandbox (`replayMode: "validation"`) with write-side tool calls skipped before the patched workflow is saved. No "AI applied a change in prod" surprises.
- **Version rollback in one click.** Every save creates a new `workflow_versions` row. Any prior version is one click from being the current version. Recovery from a bad patch is faster than getting a coffee.
- **Per-org rate limits + budget gates.** Per-org Redis-backed rate limits on every API call. Per-workflow + per-org dollar budgets gate AI calls so a runaway loop can't burn the bank.

**Compliance posture callout (sits under the bullets):**

> Janusly is built with a **SOC 2-ready architecture** (immutable audit, secret management, access controls). A formal certification is on our roadmap, not on the certificate wall yet — we are honest about ready vs certified. Data residency: self-host runs in your environment; managed-cloud regional options belong in the enterprise/security review rather than a generic landing-page claim.

**Visual style note (Claude Design):** Bullet list with subtle iconography (a tiny shield-check next to each item). Compliance callout sits in a bordered card, slightly de-emphasised, signaling "this is the honest version, not a marketing claim."

---

### C.6 For technical teams (technical buyer proof points)

**Presentation mode 1 — Quick scroll bullet list (for IC engineers scrolling):**

- Node.js 24 runtime; Postgres 18; Redis 8; BullMQ workers.
- Zod 4 DSL for the workflow grammar; the runtime validates every workflow against `WorkflowSchema` before execute.
- Provider-neutral LLM client with Anthropic as the supported runtime target (`anthropic/claude-haiku-4-5-20251001`). OpenAI remains registered for future verification, not current production use. Every AI call wraps in try/catch + AI fallback contract.
- MCP client (consume external MCP servers as workflow steps) + MCP server (expose Janusly to AI assistants).
- OpenTelemetry traces, meters, logs with `service.name="janusly"`. Drop-in for Grafana / Datadog / Honeycomb.
- Self-host via `pnpm dev` — brings up Postgres + Redis + API + worker + web in <5 min. No magic; everything is `docker compose` + standard Node tooling.
- Self-hostable posture: the runtime, the recovery loop, and the audit log are inspectable and runnable locally. Managed cloud adds hosted operations on top.

**Presentation mode 2 — Structured comparison table (for CTOs choosing a stack):**

| Layer | Janusly's choice | Why we picked it |
| --- | --- | --- |
| Runtime language | **Node.js 24 (Krypton)** | Native TypeScript, broad SDK ecosystem, easy hiring. |
| Workflow state | **Postgres 18, durable DAG** | Battle-tested durability; one source of truth; easy to back up. |
| Queue | **BullMQ on Redis 8** | Mature retry / DLQ / scheduler semantics; familiar to most teams. |
| Workflow grammar | **Zod 4 DSL** | Schema-first contracts; same validation server + client. |
| AI provider | **Provider-neutral LLM client (Anthropic supported)** | Swap models per call; no vendor lock-in; deterministic fallback. |
| Integrations | **MCP client + server, vendor-neutral HTTP tools** | No vendor SDKs; SSRF / DNS-pin / body-cap / timeout chokepoint. |
| Observability | **OpenTelemetry traces + meters; structured `run_events`** | Drop-in for Grafana / Datadog / Honeycomb. |
| Deployment | **Self-host (Docker Compose) + managed cloud** | Operator picks; the same binary runs both. |
| Multi-tenancy | **`orgId` scope on every query** | Verified by route-level tests; no "shared default org" leak. |
| Auth | **Supabase + WorkOS SSO + SCIM** | OAuth for individuals, enterprise SSO + SCIM for orgs. |

**Visual style note (Claude Design):** The bullet list reads on phone; the table reads on desktop. Render both. The "why" column in the table uses smaller / muted font.

---

### C.7 The number we measure (MTTR callout)

A short standalone block, visually emphasised.

> **Mean Time To Recovery for failed automations.**
>
> Before Janusly (manual triage): 30 minutes to 2 hours. Multiple people paged.
> With Janusly (Recovery Center loop): under 3 minutes. One operator.
>
> _These are v1 hypotheses; the private-beta data (ENG-093) will tighten the numbers._

**Visual style note (Claude Design):** Big metric card, centered, with before/after framed visually (a slash or arrow between the two). Use Cyan accent for the "after" number. The honesty caveat at the bottom is intentional — leave it in.

---

### C.8 Final CTA

A full-width block at the end of the page. **Three variants** for different traffic sources.

**Variant A — Default (organic / direct):**

> **See it for yourself in three minutes.**
> If recovery is the bottleneck on your AI workflows, you'll know in two.
> Button: `Watch the demo`

**Variant B — Paid-search / awareness traffic:**

> **You came here because something broke.**
> See how Janusly recovers a workflow live, in three minutes.
> Button: `Watch the recovery demo`

**Variant C — Partner / referral traffic:**

> **Your peers are already running their AI workflows on Janusly.**
> Book a 15-minute demo tailored to your stack.
> Button: `Book a 15-minute demo`

**Visual style note (Claude Design):** Full-width gradient (Cobalt → Cyan); single button centered; subhead in muted white. Each variant uses the same visual treatment; copy only changes.

---

### C.9 Forms

If the page hosts forms, here are the full specs.

#### Signup form (top-right "Get started" button → modal or `/signup`)

| Field | Label | Placeholder | Validation error | Required |
| --- | --- | --- | --- | --- |
| email | `Work email` | `you@company.com` | `Use a work email (not gmail / hotmail / etc.).` | yes |
| company | `Company name` | `Acme Inc.` | `Tell us where you work.` | yes |
| role | `Your role` | `e.g. VP Engineering, Ops lead, AI agency founder` | (none — free text) | no |

- **Submit button:** `Start free`
- **Success state copy:** `Welcome to Janusly. Check your inbox for the verification email.`
- **Privacy micro-line:** `We use your email to send you product updates and a quarterly product letter. Unsubscribe in one click.`

#### Demo-request form (CTA "Book a 15-minute demo")

| Field | Label | Placeholder | Required |
| --- | --- | --- | --- |
| email | `Work email` | `you@company.com` | yes |
| company | `Company name` | — | yes |
| segment | `Which segment fits best?` | dropdown: `B2B startup with ops workflows / Engineering or support team / AI builder or agency / Other` | yes |
| use_case | `What's the workflow you'd run on Janusly?` | free text, 200 chars | yes |

- **Submit button:** `Book the demo`
- **Success state copy:** `Demo booked — check your inbox for the calendar invite.`
- **Privacy micro-line:** `We use your email and use-case to tailor the demo. We don't pass it to ad networks.`

#### Newsletter form (footer)

| Field | Label | Placeholder |
| --- | --- | --- |
| email | `Email` | `you@company.com` |

- **Submit button:** `Subscribe`
- **Success state copy:** `You're subscribed.`
- **Privacy micro-line:** `One letter per quarter. Unsubscribe anytime.`

---

### C.10 Visual style notes for Claude Design (cross-section)

- **Color palette:** Cobalt `#245BFF` primary, Cyan `#06B6D4` accent. Both declared CSS-first in `apps/web/src/index.css` under `@theme`. No marketing gradients beyond Cobalt → Cyan.
- **Typography:** sans-serif, generous line-height, comfortable reading columns (≤700px). The README is the voice; the visual should match its restraint.
- **Iconography:** line icons, 2px stroke, monochrome (use accent color sparingly). No filled-in marketing illustrations of robots or brains.
- **Illustrations:** if rendered, prefer **operator-at-calm-dashboard** scenes (post-recovery confidence), not **engineer-in-crisis** scenes. The whole pitch is that Janusly turns the crisis moment into a calm one.
- **Motion:** subtle. Honor `prefers-reduced-motion: reduce` (the AI Studio app already does).
- **Density:** prefer whitespace over packed sections. The reader is a busy operator; let the eye breathe.
- **Layout breakpoints:** the AI Studio uses 1100 / 760 / 480 — match those for layout consistency between the marketing site and the in-app experience.

---

## Section D — Versión en español

### D.1 Hero

**Eyebrow / kicker:**

- Canónico: `La columna vertebral operativa de los flujos con IA`
- Alt 1: `Flujos con IA listos para producción`
- Alt 2: `Corré IA en producción, no solo en demos`

**Titular principal:**

- Canónico: `Janusly es el operador autoreparable de flujos de trabajo con IA.`
- Alt 1 (más corto): `Flujos con IA que explican, se recuperan y evolucionan con seguridad.`
- Alt 2 (más directo): `Dejá de debuggear flujos con IA a las 3am.`

**Subtítulo (2–3 oraciones):**

- Canónico: `Cada corrida es observable. Cada falla es explicable. Cada arreglo propuesto es revisable antes de tocar producción. Corré flujos con IA con la confianza operativa de correr una base de datos.`
- Alt 1: `Tu demo de IA funciona. Tu flujo con IA en producción a las 3am — eso es otra historia. Janusly es la capa entre los dos.`
- Alt 2: `Reducí el Tiempo Medio de Recuperación de automatizaciones fallidas de horas a minutos. Observable, recuperable, revisable, auditable.`

**CTAs primarios (2):**

| Orden | Etiqueta | Intención |
| --- | --- | --- |
| 1 | `Ver el demo de recuperación de 3 minutos` | Reproduce el recording de `failed-workflow-recovery` inline. |
| 2 | `Reservar un demo de 15 minutos` | Abre Calendly o similar. |

**CTAs secundarios (2):**

| Orden | Etiqueta | Intención |
| --- | --- | --- |
| 1 | `Correlo local` | Link a la sección Quick Start del README / docs. |
| 2 | `Leer la docs` | Link a la documentación pública. |

**Trust strip (debajo de los CTAs, placeholder hasta que ENG-093 ponga nombres reales):**

`Lo usan equipos de operaciones e ingeniería que llevan IA a producción.`

---

### D.2 Problema

**Apertura — Variante A (escena 3am):**

> Toda empresa está corriendo para llevar IA a producción. La mayoría descubre lo mismo en la semana tres: un LLM que funciona perfecto en demo es otra cosa a las 3am, cuando está corriendo un flujo de billing y algo upstream se rompió.

**Apertura — Variante B (escena credencial rotada):**

> Tu flujo con IA andaba perfecto en staging. Anduvo dos semanas en producción. Después la credencial rotó, la API tercera silenciosamente cambió su contrato, y tu engineer de on-call está leyendo trazas de log a las 2am en vez de dormir.

**Párrafo del medio (común):**

> Las herramientas de workflow fueron construidas para la **era de las integraciones** — conectores drag-and-drop entre APIs que ya funcionaban. No fueron pensadas para la **era de la IA**, donde la pregunta difícil no es "cómo conecto estos sistemas?" sino "qué hago cuando el modelo devuelve fruta, el secreto expiró, o un paso que funcionaba ayer hoy falla?"

**Párrafo de cierre (común):**

> Janusly es la columna vertebral operativa para flujos con IA. Cada corrida es observable, cada falla produce una explicación estructurada, cada arreglo propuesto es revisable en un sandbox antes de tocar producción, y cada cambio puede reproducirse con seguridad. El destino: un mundo donde correr un flujo con IA en producción tiene la misma confianza operativa que correr una base de datos.

---

### D.3 El loop de Janusly — copia del diagrama

Esta sección se acompaña con un diagrama visual de los 8 pasos del loop (Prompt → DAG → Run → Observe → Explain → Patch → Replay → Learn).

| # | Paso | Caption (≤16 palabras) | Alt-text del diagrama (≤8 palabras) | Micro-dato |
| --- | --- | --- | --- | --- |
| 1 | **Prompt** | Describí el flujo en lenguaje natural. Janusly arma el DAG. | Operador escribe un prompt de flujo. | `POST /ai/generate-workflow` con cliente LLM neutro al proveedor. |
| 2 | **DAG** | Editá el flujo en un canvas visual. Las versiones se guardan automáticamente. | Nodos de flujo conectados en canvas. | Canvas `React Flow`; tabla `workflow_versions` para historial. |
| 3 | **Run** | Corré sobre un runtime durable de Postgres + BullMQ. Retries, timeouts, scope multi-tenant. | Flujo ejecutando paso a paso. | `runs` + `run_nodes` + `run_events` en Postgres; worker SIGTERM-safe. |
| 4 | **Observe** | Cada ciclo de vida de un nodo emite un evento estructurado. El registro de auditoría guarda cada acción. | Línea de tiempo de eventos. | `run_events` por nodo; OpenTelemetry `service.name="janusly"`; `usage_events` por org. |
| 5 | **Explain** | Cuando un nodo falla, la IA traduce el error en una causa raíz en lenguaje claro. | IA resumiendo una falla. | `POST /ai/explain-run`; clustering por firma de error agrupa filas del DLQ similares. |
| 6 | **Patch** | La IA propone 1–3 arreglos alternativos con confianza auto-calificada. Revisás el diff antes de que algo cambie. | Operador revisando opciones de patch. | `POST /ai/patch-workflow`; envelope de config (`swap_secret_ref`, `add_retry`) + envelope estructural (`insert_approval_upstream`). |
| 7 | **Replay** | Validá el flujo parcheado en un sandbox con las llamadas de escritura saltadas. Guardá la nueva versión. Replayeá la corrida original. | Corrida de sandbox pasando a verde. | `replayMode: "validation"`; gate dryRun saltea write-side; nueva fila en `workflow_versions`. |
| 8 | **Learn** | Cada accept/reject le enseña a Janusly cómo prefiere recuperarse tu equipo. Las sugerencias se adaptan. | Una señal de feedback volviendo al loop. | Tabla `recovery_feedback`; `summarizePastFeedback` moldea los prompts de patch futuros. |

**Párrafo narrativo conector (debajo del diagrama):**

> Son las 3am. El flujo de billing falló. Abrís Janusly: la corrida fallida está al tope del Recovery Queue, con una explicación en español claro de qué se rompió. La IA propone dos arreglos — uno estructural (insertar un approval arriba), uno de config (cambiar el secreto sin enlazar). Revisás los diffs, validás en sandbox, aplicás. El replay sale verde. Son las 3:04am. Volvés a dormir.

---

### D.4 Casos de uso (3 tarjetas)

#### Tarjeta 1 — Equipos de ops en startups B2B

- **Header:** `Flujos de ops, finanzas y soporte al cliente`
- **Pain quote:** `"Las excepciones de billing me despiertan. Procesamos reembolsos en tres lugares — Stripe, nuestro admin tool, soporte al cliente — y los tres están en desacuerdo sobre cuál es la fuente de verdad."`
- **Outcome:** `Con Janusly: un solo flujo, una aprobación, una llamada de billing firmada, una fila de auditoría. La página de las 3am desaparece.`
- **CTA:** `Ver el demo de refund-triage →` (link a `recording-scripts/refund-triage.md`)

#### Tarjeta 2 — Equipos de ingeniería y soporte

- **Header:** `Triage de incidentes y ruteo de escalations`
- **Pain quote:** `"Cada incidente es el mismo triage: leer el alert, encontrar el servicio afectado, abrir el issue en GitHub, pingear al on-call, pegar el link en el canal de Slack correcto. Quince minutos de toil por incidente, y tenemos ocho por semana."`
- **Outcome:** `Con Janusly: el alert llega, la IA resume, GitHub abre el issue, Slack pingea al canal. Quince minutos recuperados, ocho veces por semana.`
- **CTA:** `Ver el demo de incident-triage →` (link a `recording-scripts/incident-triage.md`)

#### Tarjeta 3 — AI builders y agencias

- **Header:** `Runtime de producción para flujos con IA de clientes`
- **Pain quote:** `"Armé un gran demo de agente para el cliente. Ahora quieren ponerlo en producción y me di cuenta de que no tengo nada — sin runtime, sin registro de auditoría, sin forma de hacer rollback cuando el modelo se manda una macana."`
- **Outcome:** `Con Janusly: runtime durable, registro de auditoría, rollback de versión, cliente y servidor MCP, primitiva multi-agente. Seis semanas de código pegamento por cliente se vuelve un paso de configuración.`
- **CTA:** `Explorar el demo multi-agente →` (link a `../demos/multi-agent-decision.md`)

---

### D.5 Seguridad y control

- **Scope multi-tenant en cada query.** Cada query a la base lleva `eq(<tabla>.orgId, auth.orgId)`. Sin path de leak por "org_id compartido". Verificado por tests a nivel de ruta.
- **Registro de auditoría: una fila por acción.** Cada save de flujo, cada inicio de corrida, cada decisión de aprobación, cada feedback de recuperación — una fila en `audit_logs` con el actor, la acción, el target, y la metadata. El cierre de finanzas de fin de año se vuelve un solo SELECT.
- **Los secretos viven en env, no en la base de datos.** La fila en `credentials` guarda solo el NOMBRE de la env-var; el valor del secreto nunca sale del vault del operador. Los errores de las tools nunca devuelven el nombre de la env-var al output del flujo.
- **SSO vía WorkOS, SCIM vía WorkOS Directory Sync.** El SSO enterprise (SAML, OIDC) y el provisioning SCIM van por WorkOS. Los usuarios OAuth existentes mantienen su sesión de Supabase; el SSO es aditivo.
- **Validá en sandbox antes de guardar.** Cada patch propuesto por la IA corre en un sandbox (`replayMode: "validation"`) con las llamadas de escritura saltadas antes de guardar el flujo parcheado. Sin sorpresas de "la IA aplicó un cambio en prod".
- **Rollback de versión en un click.** Cada save crea una nueva fila en `workflow_versions`. Cualquier versión anterior está a un click de volver a ser la actual. Recuperarse de un patch malo es más rápido que ir a buscar café.
- **Rate limits + budget gates por organización.** Rate limits por org con Redis en cada llamada a la API. Presupuestos en dólares por flujo + por org gatean las llamadas de IA para que un loop runaway no queme el banco.

**Postura de compliance (callout):**

> Janusly está construido con una **arquitectura SOC 2-ready** (auditoría inmutable, manejo de secretos, control de accesos). La certificación formal está en el roadmap, no en la pared de certificados — somos honestos con "listo" vs "certificado". Residencia de datos: self-host corre en tu entorno; las opciones regionales del cloud manejado pertenecen a la revisión enterprise/security, no a un claim genérico del landing.

---

### D.6 Para equipos técnicos (pruebas para compradores técnicos)

**Modo 1 — Lista de bullets para scroll rápido (ICs):**

- Runtime Node.js 24; Postgres 18; Redis 8; workers de BullMQ.
- DSL Zod 4 para la gramática del workflow; el runtime valida cada flujo contra `WorkflowSchema` antes de ejecutar.
- Cliente LLM neutro al proveedor con Anthropic como runtime soportado (`anthropic/claude-haiku-4-5-20251001`). OpenAI sigue registrado para verificación futura, no para uso actual en producción. Cada llamada de IA va envuelta en try/catch + contrato de fallback de IA.
- Cliente MCP (consumí servidores MCP externos como pasos del flujo) + servidor MCP (exponé Janusly a asistentes de IA).
- Trazas, métricas y logs de OpenTelemetry con `service.name="janusly"`. Drop-in para Grafana / Datadog / Honeycomb.
- Self-host vía `pnpm dev` — levanta Postgres + Redis + API + worker + web en menos de 5 min. Sin magia; todo es `docker compose` + tooling Node estándar.
- Postura self-host: el runtime, el loop de recuperación y el registro de auditoría son inspeccionables y corribles localmente. El cloud manejado agrega operación hospedada encima.

**Modo 2 — Tabla estructurada de comparación (CTOs eligiendo stack):**

| Capa | Decisión de Janusly | Por qué la elegimos |
| --- | --- | --- |
| Lenguaje de runtime | **Node.js 24 (Krypton)** | TypeScript nativo, ecosistema SDK amplio, hiring fácil. |
| Estado de workflow | **Postgres 18, DAG durable** | Durabilidad probada en batalla; una fuente de verdad; backup fácil. |
| Cola | **BullMQ sobre Redis 8** | Semántica madura de retry / DLQ / scheduler; familiar para la mayoría. |
| Gramática del workflow | **DSL Zod 4** | Contratos schema-first; misma validación server + client. |
| Proveedor de IA | **Cliente LLM neutro (Anthropic supported)** | Cambiá modelo por llamada; sin vendor lock-in; fallback determinístico. |
| Integraciones | **Cliente y servidor MCP, tools HTTP neutras** | Sin SDKs de vendor; chokepoint SSRF / DNS-pin / body-cap / timeout. |
| Observabilidad | **Trazas y métricas OpenTelemetry; `run_events` estructurados** | Drop-in para Grafana / Datadog / Honeycomb. |
| Deployment | **Self-host (Docker Compose) + cloud manejado** | El operador elige; el mismo binario corre ambos. |
| Multi-tenancy | **Scope por `orgId` en cada query** | Verificado por tests a nivel de ruta. |
| Auth | **Supabase + SSO WorkOS + SCIM** | OAuth para individuos, SSO enterprise + SCIM para organizaciones. |

---

### D.7 La métrica que medimos (MTTR callout)

> **Tiempo Medio de Recuperación de automatizaciones fallidas.**
>
> Antes de Janusly (triage manual): 30 minutos a 2 horas. Múltiples personas pagadas.
> Con Janusly (loop del Recovery Center): bajo 3 minutos. Un operador.
>
> _Estas son hipótesis v1; los datos del private-beta (ENG-093) van a precisar los números._

---

### D.8 CTA final

**Variante A — Default (orgánico / directo):**

> **Verlo vos mismo en tres minutos.**
> Si la recuperación es el cuello de botella de tus flujos con IA, lo vas a ver en dos.
> Botón: `Ver el demo`

**Variante B — Tráfico de paid-search / awareness:**

> **Llegaste acá porque algo se rompió.**
> Mirá cómo Janusly recupera un flujo en vivo, en tres minutos.
> Botón: `Ver el demo de recuperación`

**Variante C — Tráfico de partners / referidos:**

> **Tus pares ya están corriendo sus flujos con IA en Janusly.**
> Reservá un demo de 15 minutos adaptado a tu stack.
> Botón: `Reservar un demo de 15 minutos`

---

### D.9 Formularios

#### Formulario de signup ("Empezar")

| Campo | Etiqueta | Placeholder | Error de validación | Requerido |
| --- | --- | --- | --- | --- |
| email | `Email de trabajo` | `vos@empresa.com` | `Usá un email de trabajo (no gmail / hotmail).` | sí |
| company | `Nombre de la empresa` | `Acme Inc.` | `Decinos dónde trabajás.` | sí |
| role | `Tu rol` | `ej. VP Engineering, Ops lead, founder de agencia AI` | (sin validación — texto libre) | no |

- **Botón submit:** `Empezar gratis`
- **Estado de éxito:** `Bienvenido a Janusly. Revisá tu bandeja de entrada para el email de verificación.`
- **Privacidad:** `Usamos tu email para mandarte actualizaciones de producto y una carta trimestral. Te desuscribís con un click.`

#### Formulario de demo (CTA "Reservar un demo de 15 minutos")

| Campo | Etiqueta | Placeholder | Requerido |
| --- | --- | --- | --- |
| email | `Email de trabajo` | `vos@empresa.com` | sí |
| company | `Nombre de la empresa` | — | sí |
| segment | `¿Qué segmento describe mejor a tu equipo?` | dropdown: `Startup B2B con flujos de ops / Equipo de ingeniería o soporte / AI builder o agencia / Otro` | sí |
| use_case | `¿Qué flujo correrías sobre Janusly?` | texto libre, 200 chars | sí |

- **Botón submit:** `Reservar el demo`
- **Estado de éxito:** `Demo reservado — revisá tu inbox para la invitación al calendario.`
- **Privacidad:** `Usamos tu email y tu use-case para adaptar el demo. No los pasamos a redes publicitarias.`

#### Formulario de newsletter (footer)

| Campo | Etiqueta | Placeholder |
| --- | --- | --- |
| email | `Email` | `vos@empresa.com` |

- **Botón submit:** `Suscribirme`
- **Estado de éxito:** `Listo, estás suscrito.`
- **Privacidad:** `Una carta por trimestre. Te desuscribís cuando quieras.`

---

### D.10 Notas de estilo visual (mismo bloque que C.10, idéntico para mantener consistencia entre el sitio en inglés y el sitio en español)

Los lineamientos visuales son **idénticos** al bloque C.10. La paleta, tipografía, iconografía, ilustraciones, motion, densidad y breakpoints son compartidos entre ambos idiomas.

---

## Section E — Translation + voice notes

### Decisiones de traducción documentadas

- **"self-healing" → "autoreparable" (no "autocurativo").** "Curativo" carga connotaciones biológicas/médicas (curar heridas, sanar) que leen como exceso para un runtime de software. "Autoreparable" mapea al verbo "reparar" — que es exactamente el verbo que usa el UI del producto ("Janusly te ayuda a reparar el flujo"). La elección mantiene el copy del landing y el copy del producto en lockstep.
- **"workflow" → "flujo de trabajo" (largo) / "flujo" (corto).** El UI del producto usa "flujo" en contextos cortos (botones, etiquetas) y "flujo de trabajo" en prosa. Seguimos esa misma convención acá.
- **"Recovery Center" → "Centro de Recuperación".** Verbatim del UI (`apps/web/src/i18n/locales/es/common.json:recoveryCenter`). No usar "Hub de Recuperación" ni "Centro de Recovery" — drift.
- **"sandbox" / "rollback" / "DAG" → quedan en inglés.** Son anglicismos aceptados en español técnico. Traducirlos ("caja de arena" / "reversión" / "grafo acíclico dirigido") sería un esfuerzo de traducción contraproducente y leería como mal copy.
- **"Mean Time To Recovery" → "Tiempo Medio de Recuperación"** (el sustantivo se traduce). El acrónimo MTTR queda en inglés en ambos idiomas porque es estándar de la industria.
- **"self-host" → "self-host" (anglicismo) en docs técnicos / dev**; **"auto-hospedaje"** en copy de marketing si la audiencia es no-técnica. En este landing usamos "self-host" porque la audiencia técnica lo prefiere.

### Reglas de tono (español)

- **No "usted".** Usar "tú" o impersonal. "Acá podés correr Janusly local" no "Aquí puede usted correr Janusly localmente".
- **Concreto sobre abstracto.** Las escenas concretas ("son las 3am, billing falló") aterrizan mejor que los claims abstractos ("permitimos resiliencia operacional"). Vale para ambos idiomas.
- **Nunca "la IA lo arregla todo".** El humano está en el loop. La IA propone; el operador decide. Cualquier línea que sugiera lo contrario hay que reescribirla. Vale para ambos idiomas.
- **MTTR como métrica de récord.** Cuando nombramos un número, es Tiempo Medio de Recuperación de automatizaciones fallidas. Otras métricas son indicadores; MTTR es la que medimos.
- **Anti-posicionamiento sin sarcasmo.** Decir qué NO es Janusly (no Zapier, no n8n, no RPA, no agentes que hacen todo) es respeto al tiempo del comprador, no burla. Mantener crujiente, no chistoso.

---

## Section F — Claude Design handoff notes

**Prioridades de conversión (alto → bajo):**

1. **Hero (C.1 / D.1).** El 80% de los visitantes solo ven esto. Highest-impact A/B test surface — testear las 3 variantes de headline contra cada audiencia (paid vs orgánico vs partner).
2. **Final CTA (C.8 / D.8).** El 15% que llega al final son los más calificados. Las 3 variantes están listas para usar por traffic source.
3. **Use cases (C.4 / D.4).** Los segmentos están fijos (3 tarjetas, una por segmento de ICP). Iconos definidos vía prompt; la tarjeta que toque al segmento del visitante debería highlightearse si tenemos hint de UTM / referrer.

**Secciones con variantes listas para A/B:**

- **Hero headline:** 3 variantes (canónica + 2 alts) en cada idioma.
- **Hero subhead:** 3 variantes.
- **Problem statement opener:** 2 variantes (3am scene vs credential-rotated scene).
- **Final CTA:** 3 variantes por traffic source.

Otras secciones (Janusly loop, security/control, technical proof points, MTTR callout, forms) tienen UNA versión canónica — sin variantes A/B. Si Claude Design quiere generar más, primero pasar por revisión de voz contra `narrative.md`.

**Diagrama del loop:**

Renderizar el diagrama del Janusly loop (C.3 / D.3) horizontalmente con flecha de "Learn" volviendo a "Prompt" para enfatizar que es un loop, no una pipeline lineal. Si la decisión es renderizar vertical, dejar el flow visualmente igual y mantener el alt-text por nodo.

**Imágenes / ilustraciones:**

- Hero: operador-en-dashboard-en-calma. NO crisis-en-vivo.
- Cards: iconos line-style 2px stroke. Los icon-prompts están en cada tarjeta.
- Security section: opcional — un shield-check minimal junto a cada bullet.
- MTTR callout: tipográfico, no ilustrativo. Big numbers + slash entre ANTES y DESPUÉS.

**Layout breakpoints:**

Match con los del AI Studio: 1100 / 760 / 480 px. Mantener consistencia entre marketing y in-app surfaces.

**Internationalización:**

- URL slug español: `/es/` prefix. Hreflang tags en `<head>` para indicar `en` ↔ `es` parallel versions.
- Detección automática de idioma por `Accept-Language` con override manual via dropdown (footer top-right).
- Las traducciones en `apps/web/src/i18n/locales/es/common.json` son la base de vocabulario para términos de producto; si el landing introduce un término nuevo de marketing, documentarlo en Section E.

**Out of scope para Claude Design (cosas que vienen después):**

- Página de pricing (`/pricing` / `/es/precios`) — ENG-068.
- Tabla competitiva contra Zapier / n8n / Workato — la versión operativa interna ya existe en [`docs/marketing/competitive-positioning.md`](competitive-positioning.md). La página pública (`/compare/zapier`, `/compare/n8n`, etc.) es un ticket futuro de implementación web.
- Página de blog / case studies — futuro post-ENG-093.
- Status page / changelog — ya existe como link, no parte del landing core.

**Punto de contacto para iterar:** cuando Claude Design genere la página, los entregables que recibimos de vuelta van a `docs/marketing/landing-page-design-iterations/` (carpeta futura, no creada por este ticket).
