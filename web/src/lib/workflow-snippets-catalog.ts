/** Built-in recipe data and lookup, separate from client-side insertion. */

import { BUILTIN_SNIPPET_ID_PREFIX, type SnippetCategory } from './workflow-snippets-values'
import type { SnippetDefinition, SnippetNode, SnippetEdge } from './workflow-snippets'

// ---------- built-in snippets (code, read-only) ----------

/**
 * The nine built-in snippets that ship with every install. These live in
 * CODE (never the DB), are `builtin: true`, and are surfaced read-only by
 * `GET /snippets`. Their `id`s are `builtin:<slug>`; their display copy is
 * resolved on the web via the EN/ES `snippets.builtin.<slug>.*` keys, so
 * the `name`/`description` here are English fallbacks only.
 *
 * Each snippet's node `config` is a sensible default the operator tunes
 * after insertion. Node-type strings match the engine's closed node-type
 * vocabulary; the inserted workflow re-validates through `WorkflowSchema`.
 */
function builtin(
  slug: string,
  name: string,
  description: string,
  category: SnippetCategory,
  tags: string[],
  nodes: SnippetNode[],
  edges: SnippetEdge[],
  entryNodeId?: string,
): SnippetDefinition {
  return {
    id: `${BUILTIN_SNIPPET_ID_PREFIX}${slug}`,
    name,
    description,
    category,
    tags,
    builtin: true,
    nodes,
    edges,
    ...(entryNodeId ? { entryNodeId } : {}),
  }
}

export const BUILTIN_SNIPPETS: readonly SnippetDefinition[] = [
  builtin(
    'retry-with-backoff',
    'Retry with backoff',
    'An HTTP call wrapped with bounded exponential-backoff retries.',
    'retry',
    ['http', 'resilience'],
    [
      {
        id: 'call',
        type: 'http',
        config: {
          method: 'GET',
          url: 'https://api.example.com/resource',
          retry: { maxAttempts: 4, backoff: 'exponential', delayMs: 500 },
        },
      },
    ],
    [],
    'call',
  ),
  builtin(
    'approval-with-timeout',
    'Approval with timeout',
    'A human approval gate that fails closed when its one-hour decision deadline expires.',
    'approval',
    ['approval', 'human-in-the-loop'],
    [
      {
        id: 'approve',
        type: 'approval',
        config: {
          message: 'Approve before continuing?',
          decisionTimeoutMs: 3_600_000,
          onTimeout: 'fail',
        },
      },
    ],
    [],
    'approve',
  ),
  builtin(
    'slack-on-failure',
    'Slack on failure',
    'Post a Slack message when an upstream step fails (wire the condition edge to your failure branch).',
    'notification',
    ['slack', 'alerting'],
    [
      {
        id: 'notify',
        type: 'tool',
        config: {
          tool: 'slack.post',
          resultPolicy: 'require_ok',
          input: { credential: 'slack_webhook', text: 'A workflow step failed.' },
        },
      },
    ],
    [],
    'notify',
  ),
  builtin(
    'condition-then-branch',
    'Condition then branch',
    'A condition node that splits into a true branch and a false branch.',
    'transform',
    ['condition', 'branching'],
    [
      { id: 'check', type: 'condition', config: { expression: 'context.input.amount > 100' } },
      { id: 'high', type: 'noop', config: {} },
      { id: 'low', type: 'noop', config: {} },
    ],
    [
      { from: 'check', to: 'high', condition: 'context.input.amount > 100' },
      { from: 'check', to: 'low' },
    ],
    'check',
  ),
  builtin(
    'parallel-fan-out',
    'Parallel fan-out',
    'Fork into two parallel branches and join their results.',
    'transform',
    ['parallel', 'fan-out'],
    [
      { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }] } },
      { id: 'branch_a', type: 'noop', config: {} },
      { id: 'branch_b', type: 'noop', config: {} },
      { id: 'join', type: 'join', config: { sources: { a: 'branch_a', b: 'branch_b' } } },
    ],
    [
      { from: 'fork', to: 'branch_a' },
      { from: 'fork', to: 'branch_b' },
      { from: 'branch_a', to: 'join' },
      { from: 'branch_b', to: 'join' },
    ],
    'fork',
  ),
  builtin(
    'transform-and-enrich',
    'Transform and enrich',
    'Reshape an upstream payload, then add a deterministic metadata field.',
    'transform',
    ['transform', 'mapping'],
    [
      {
        id: 'shape',
        type: 'transform',
        config: { mapping: { id: '{{context.fetch.output.id}}', total: '{{context.fetch.output.amount}}' } },
      },
      {
        id: 'enrich',
        type: 'tool',
        config: {
          tool: 'json.set',
          input: {
            path: 'metadata.prepared',
            value: true,
            source: '{{context.shape.output}}',
          },
        },
      },
    ],
    [{ from: 'shape', to: 'enrich' }],
    'shape',
  ),
  builtin(
    'http-with-circuit-breaker',
    'HTTP with circuit breaker',
    'An HTTP call guarded by a condition that short-circuits when the upstream is unhealthy.',
    'error_handling',
    ['http', 'circuit-breaker', 'resilience'],
    [
      { id: 'breaker', type: 'condition', config: { expression: 'context.health.output.healthy == true' } },
      {
        id: 'request',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com/action',
        },
      },
      { id: 'short_circuit', type: 'noop', config: { note: 'upstream unhealthy — skipped' } },
    ],
    [
      { from: 'breaker', to: 'request', condition: 'context.health.output.healthy == true' },
      { from: 'breaker', to: 'short_circuit' },
    ],
    'breaker',
  ),
  builtin(
    'dlq-friendly-error-flow',
    'DLQ-friendly error flow',
    'A write action that fails closed into governed recovery without an unsafe blind retry.',
    'error_handling',
    ['dlq', 'error-handling', 'resilience'],
    [
      {
        id: 'action',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com/submit',
        },
      },
    ],
    [],
    'action',
  ),
  builtin(
    'webhook-to-transform',
    'Webhook to transform',
    'Receive a named webhook event and reshape its payload for downstream steps.',
    'trigger',
    ['webhook', 'trigger'],
    [
      { id: 'inbox', type: 'webhook_received', config: { endpointKey: 'orders' } },
      {
        id: 'shape',
        type: 'transform',
        config: { mapping: { total: '{{context.inbox.output.event.payload.total}}' } },
      },
    ],
    [{ from: 'inbox', to: 'shape' }],
    'inbox',
  ),
]

/** Quick lookup by wire id (`builtin:<slug>`). */
const BUILTIN_BY_ID: ReadonlyMap<string, SnippetDefinition> = new Map(
  BUILTIN_SNIPPETS.map((snippet) => [snippet.id, snippet]),
)

/** Resolve a built-in snippet by its `builtin:<slug>` wire id, or null. */
export function getBuiltinSnippet(id: string): SnippetDefinition | null {
  return BUILTIN_BY_ID.get(id) ?? null
}

