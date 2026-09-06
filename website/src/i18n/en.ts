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
    compare: 'Compare',
    pricing: 'Pricing',
    faq: 'FAQ',
    docs: 'Docs',
  },
  hero: {
    pill: 'Self-hosted · one executable · your PostgreSQL',
    title: 'The AI operator for your business workflows.',
    lede:
      'Janusly designs workflows with you, runs them on a durable queue, and when a step breaks it clusters the failures, replays them and shows you the evidence. One Go binary, on your infrastructure.',
    note: 'Docker image or a single binary. PostgreSQL 18. No control plane to rent.',
    screenshotAlt: 'Janusly Recovery queue with two open failures and one selected',
    caption: 'The Recovery queue: every failed step, clustered by cause, one click from a replay.',
  },
  trust: {
    binary: 'One Go executable',
    postgres: 'PostgreSQL as the durable queue',
    mcp: 'MCP client and server',
    otel: 'OpenTelemetry built in',
    selfHosted: 'Self-hosted, credentials never leave',
  },
  why: {
    kicker: 'Why Janusly',
    title: 'Four jobs most tools split across four products.',
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
  compare: {
    kicker: 'Compare',
    title: 'Where it sits next to what you may already run.',
    lede:
      'Integration platforms are fast to start; workflow engines are durable; Janusly is the operator on top: durable, self-hosted, and built around recovery.',
    capability: 'Capability',
    columns: { janusly: 'Janusly', ipaas: 'Hosted iPaaS', lowcode: 'Low-code automation', engine: 'Workflow engine' },
    yes: 'Yes',
    no: 'No',
    rows: {
      selfHosted: { label: 'Self-hosted single binary + PostgreSQL', engine: 'Cluster + services' },
      recovery: { label: 'Recovery with evidence (clusters, replay, validated auto-healing)', ipaas: 'Manual replay', lowcode: 'Manual replay', engine: 'Retries, no operator' },
      operator: { label: 'AI operator: intent brief to a readable workflow', ipaas: 'Assistants, hosted', lowcode: 'Nodes, not an operator' },
      mcp: { label: 'MCP client and MCP server', ipaas: 'Client only', lowcode: 'Client only' },
      budgets: { label: 'AI spend budgets, RED metrics and traces included', ipaas: 'Task quotas', lowcode: 'Add-ons', engine: 'Metrics, no budgets' },
    },
    note: 'Categories, not vendors.',
  },
  pricing: {
    kicker: 'Pricing',
    title: 'Run it yourself for free. Pay when you want us on call.',
    selfHosted: {
      name: 'Self-hosted',
      price: 'Free',
      tagline: 'The binary, the image, unlimited workflows.',
      features: ['Full runtime and Recovery Center', 'Bring your own AI provider key', 'Community support'],
      cta: 'Get the binary',
    },
    team: {
      name: 'Team',
      price: 'Talk to us',
      tagline: 'For teams that run workflows others depend on.',
      features: ['Everything in Self-hosted', 'WorkOS SSO and SCIM provisioning', 'Managed updates and priority support'],
      cta: 'Reach out on GitHub',
    },
    enterprise: {
      name: 'Enterprise',
      price: 'Custom',
      tagline: 'Recovery SLAs, dedicated support, procurement.',
      features: ['Everything in Team', 'Audit log retention', 'Named engineer, onboarding'],
      cta: 'Talk to us',
    },
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
        a: 'In your PostgreSQL. Credentials are envelope-encrypted at rest and never appear in lists, logs or error payloads; outbound calls pass SSRF checks, DNS pinning and byte limits.',
      },
      {
        q: 'What happens when the AI provider is down or over budget?',
        a: 'The run keeps going. Every AI step has a deterministic fallback envelope, and a budget block stops the paid call, not the workflow. Anthropic is the provider today; you bring the key.',
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
    title: 'Run your first workflow in ten minutes.',
    body: 'Pull the image, point it at PostgreSQL, open the Recovery Center. Nothing to sign up for.',
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
