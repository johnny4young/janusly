export const en = {
  meta: {
    title: 'Janusly — The AI operator for your business workflows',
    description:
      'Design workflows with AI, run them on a durable PostgreSQL queue, and recover failures with the evidence attached. One Go executable, on your infrastructure.',
  },
  common: {
    languageSelect: 'Language',
    skipToContent: 'Skip to content',
    homeAria: 'Janusly home',
    primaryNav: 'Primary navigation',
    mobileNav: 'Mobile navigation',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    github: 'GitHub',
    getStarted: 'Get started',
    seeRecoveryCenter: 'See the Recovery Center',
    readDocs: 'Read the docs',
    talkToUs: 'Talk to us',
  },
  nav: {
    why: 'Why Janusly',
    product: 'Product',
    pricing: 'Access',
    faq: 'FAQ',
    docs: 'Docs',
  },
  hero: {
    pill: 'Self-hosted · one executable · your PostgreSQL',
    title: 'The AI operator for your business workflows.',
    lede:
      'Janusly turns intent into a reviewable workflow, checks declared business outcomes, and brings failures into governed recovery. Technical completion is not the same as a verified result. One Go binary, on your infrastructure.',
    note: 'Docker image or a single binary. PostgreSQL 18. No control plane to rent.',
    screenshotAlt: 'Janusly Recovery queue with two open failures and one selected',
    caption: 'The Recovery queue: every failed step, clustered by cause, one click from a replay.',
  },
  trust: {
    binary: 'One Go executable',
    postgres: 'PostgreSQL as the durable queue',
    mcp: 'MCP client and server',
    otel: 'OpenTelemetry built in',
    selfHosted: 'Tenant-scoped credentials',
  },
  why: {
    kicker: 'Why Janusly',
    title: 'Design, run, verify and recover in one place.',
    lede:
      'Design, run, recover and operate live in the same runtime, so a failure on Tuesday is a workflow change on Wednesday, with the evidence attached.',
    design: {
      title: 'Design',
      body:
        'Describe the outcome. AI Studio compiles an intent brief into a workflow you can read, with every tool, credential and approval named before anything runs.',
    },
    run: {
      title: 'Run',
      body:
        'Every step is a row in your PostgreSQL. Idempotent starts, bounded workers, LISTEN/NOTIFY wake-ups and polling as the fallback, so nothing depends on a broker you have to babysit.',
    },
    recover: {
      title: 'Recover',
      body:
        'Failures are clustered by cause. Replay one, run a campaign over the cluster, or let auto-healing propose a fix that is validated on one sample first, with external writes suppressed. Recovery contracts carry fixtures that must pass before a rollout.',
    },
    operate: {
      title: 'Operate',
      body:
        'AI spend budgets per workflow, alert policies, a circuit breaker that pauses every entry point until you resume, public status pages, and metrics and traces out of the box.',
    },
  },
  product: {
    kicker: 'Product',
    title: 'What an operator sees on a bad morning.',
    lede: 'Three surfaces, one runtime, no diagrams: every screen below is the product over a seeded organization.',
    screens: {
      recovery: {
        title: 'Recovery Center',
        caption: 'The queue of failed steps, the cluster they belong to, replay campaigns and the auto-healing proposals waiting for a decision.',
        alt: 'Janusly Recovery Center: the failure queue with the automation panel open',
      },
      studio: {
        title: 'AI Studio',
        caption: 'An intent brief compiled from a sentence, the capabilities it binds to, and a proposal you read before it becomes a draft.',
        alt: 'Janusly AI Studio: a compiled intent brief and a workflow proposal',
      },
      home: {
        title: 'Home',
        caption: 'The operator landing: outcome posture, the longest downtime still counting, and the next action, computed from your runs.',
        alt: 'Janusly Home: the Recovery Center landing with health ring and next actions',
      },
    },
  },
  pricing: {
    kicker: 'Access',
    title: 'Evaluate Janusly on your infrastructure.',
    body: 'Review the product and its evidence first. Use requires prior written permission; contact the copyright holder about licensing and deployment.',
    cta: 'Discuss access on GitHub',
  },
  faq: {
    kicker: 'FAQ',
    title: 'Questions operators ask first.',
    items: [
      {
        q: 'Do I need Kubernetes?',
        a: 'No. One executable serves the API, the web app, the workers and the maintenance loops, and PostgreSQL 18 is the only dependency. A container image build is part of every release.',
      },
      {
        q: 'Where does my data live?',
        a: 'Workflow state and evidence live in your PostgreSQL. Configured integrations and AI providers receive the data needed for their calls. Credentials are encrypted at rest and withheld from lists, logs and error payloads; authorized provider calls use them.',
      },
      {
        q: 'What happens when the AI provider is down or over budget?',
        a: 'AI calls return a deterministic fallback envelope when unavailable or over budget. A fallback is not proof that the business objective was met: configured outcome checks can still reject it or quarantine downstream work.',
      },
      {
        q: 'Can it use my existing tools and agents?',
        a: 'Yes. Janusly is an MCP client for your tools and an MCP server that exposes your workflows to the agents you already run.',
      },
      {
        q: 'Is it available in Spanish?',
        a: 'The product ships in English and Spanish, and so does this site.',
      },
    ],
  },
  finalCta: {
    title: 'Start with one workflow you can verify.',
    body: 'Review the provider-free walkthrough and its evidence limits before authorizing actions against a real service.',
  },
  footer: {
    rights: '© 2026 Janusly · janusly.app',
    docs: 'Docs',
    github: 'GitHub',
    security: 'Security',
    contact: 'Contact',
  },
} as const;

/** The English dictionary's shape with every literal widened, so the Spanish
 *  dictionary must match key for key without repeating the English strings. */
type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Widen<U>[]
    : { [K in keyof T]: Widen<T[K]> };

export type Dictionary = Widen<typeof en>;
