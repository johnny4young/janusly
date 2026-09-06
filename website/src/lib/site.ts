/**
 * Site-wide constants. Single source of truth for URLs, repo coordinates and
 * the tagline used across <head>.
 */

export const SITE = {
  url: 'https://janusly.app',
  name: 'Janusly',
  tagline: 'The AI operator for your business workflows.',
  description:
    'Janusly designs, runs, recovers and operates business workflows from one Go executable: React control plane, PostgreSQL as the durable queue, MCP client and server, OpenTelemetry built in.',
  contactEmail: 'hello@janusly.app',
  social: {
    githubUrl: 'https://github.com/johnny4young/janusly',
  },
  docsUrl: 'https://github.com/johnny4young/janusly/tree/main/docs',
  getStartedUrl: 'https://github.com/johnny4young/janusly#start-locally',
  securityUrl: 'https://github.com/johnny4young/janusly#security-posture',
} as const;

export const NAV = [
  { href: '#why', key: 'why' },
  { href: '#product', key: 'product' },
  { href: '#compare', key: 'compare' },
  { href: '#pricing', key: 'pricing' },
  { href: '#faq', key: 'faq' },
] as const;
