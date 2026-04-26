import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from './workflow-validation.ts';

test('validateWorkflow reports duplicated node ids', () => {
  const result = validateWorkflow({
    nodes: [
      { id: 'a', type: 'noop', config: {} },
      { id: 'a', type: 'noop', config: {} },
    ],
    edges: [],
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => issue.code === 'duplicate_node_id'), true);
});

test('validateWorkflow reports graph cycles', () => {
  const result = validateWorkflow({
    nodes: [
      { id: 'a', type: 'noop', config: {} },
      { id: 'b', type: 'noop', config: {} },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => issue.code === 'cycle_detected'), true);
});

test('validateWorkflow accepts simple acyclic graph', () => {
  const result = validateWorkflow({
    nodes: [
      { id: 'start', type: 'noop', config: {} },
      { id: 'task', type: 'http', config: { url: 'https://example.com' } },
    ],
    edges: [{ from: 'start', to: 'task' }],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});
