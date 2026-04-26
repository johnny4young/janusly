import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowSchema } from './workflow.ts';

test('WorkflowSchema accepts a valid DAG payload', () => {
  const result = WorkflowSchema.safeParse({
    id: 'wf-1',
    nodes: [{ id: 'n1', type: 'noop', config: {} }],
    edges: [],
  });

  assert.equal(result.success, true);
});

test('WorkflowSchema rejects edges with missing endpoints', () => {
  const result = WorkflowSchema.safeParse({
    id: 'wf-1',
    nodes: [{ id: 'n1', type: 'noop', config: {} }],
    edges: [{ from: 'n1' }],
  });

  assert.equal(result.success, false);
});
