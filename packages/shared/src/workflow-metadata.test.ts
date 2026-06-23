import { describe, expect, it } from 'vitest'

import {
  DeleteWorkflowFolderBodySchema,
  RenameWorkflowFolderBodySchema,
  SetWorkflowFolderBodySchema,
  UpsertWorkflowMetadataBodySchema,
  WORKFLOW_METADATA_FOLDER_MAX_LENGTH,
  WORKFLOW_METADATA_OWNERS_MAX,
  WORKFLOW_METADATA_RUNBOOK_MAX_BYTES,
  WORKFLOW_METADATA_TAGS_MAX,
  WorkflowMetadataSchema,
} from './workflow-metadata'

describe('WorkflowMetadataSchema — happy path', () => {
  it('accepts an empty object (every field optional)', () => {
    const parsed = WorkflowMetadataSchema.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.owners).toEqual([])
      expect(parsed.data.tags).toEqual([])
    }
  })

  it('accepts the fully populated form', () => {
    const result = WorkflowMetadataSchema.safeParse({
      owners: ['user-alpha', 'user-beta'],
      runbookMarkdown: '# Runbook\n\n1. Step one\n2. Step two',
      description: 'Daily ACH batch run',
      tags: ['billing', 'critical'],
      slackChannel: '#payouts-alerts',
      linearProject: 'acme/payouts',
      severityDefault: 'p1',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a linear.app URL for linearProject', () => {
    expect(
      WorkflowMetadataSchema.safeParse({ linearProject: 'https://linear.app/acme/project/PAY' }).success,
    ).toBe(true)
  })
})

describe('WorkflowMetadataSchema — size caps', () => {
  it('rejects runbook over 32 KiB', () => {
    const huge = 'x'.repeat(WORKFLOW_METADATA_RUNBOOK_MAX_BYTES + 1)
    expect(WorkflowMetadataSchema.safeParse({ runbookMarkdown: huge }).success).toBe(false)
  })

  it('rejects runbook over 32 KiB by UTF-8 bytes', () => {
    const huge = '€'.repeat(Math.floor(WORKFLOW_METADATA_RUNBOOK_MAX_BYTES / 3) + 1)
    expect(WorkflowMetadataSchema.safeParse({ runbookMarkdown: huge }).success).toBe(false)
  })

  it(`rejects more than ${WORKFLOW_METADATA_OWNERS_MAX} owners`, () => {
    const owners = Array.from({ length: WORKFLOW_METADATA_OWNERS_MAX + 1 }, (_, i) => `u${i}`)
    expect(WorkflowMetadataSchema.safeParse({ owners }).success).toBe(false)
  })

  it(`rejects more than ${WORKFLOW_METADATA_TAGS_MAX} tags`, () => {
    const tags = Array.from({ length: WORKFLOW_METADATA_TAGS_MAX + 1 }, (_, i) => `t${i}`)
    expect(WorkflowMetadataSchema.safeParse({ tags }).success).toBe(false)
  })

  it('rejects an empty-string owner', () => {
    expect(WorkflowMetadataSchema.safeParse({ owners: [''] }).success).toBe(false)
  })

  it('rejects an empty-string tag', () => {
    expect(WorkflowMetadataSchema.safeParse({ tags: [''] }).success).toBe(false)
  })
})

describe('WorkflowMetadataSchema — slackChannel', () => {
  it('accepts a #channel-name with hyphens', () => {
    expect(WorkflowMetadataSchema.safeParse({ slackChannel: '#alerts-prod' }).success).toBe(true)
  })

  it('rejects a channel id paste (channels/C12345)', () => {
    expect(WorkflowMetadataSchema.safeParse({ slackChannel: 'channels/C12345' }).success).toBe(false)
  })

  it('rejects a missing # prefix', () => {
    expect(WorkflowMetadataSchema.safeParse({ slackChannel: 'alerts-prod' }).success).toBe(false)
  })
})

describe('WorkflowMetadataSchema — linearProject', () => {
  it('rejects a non-linear.app URL', () => {
    expect(
      WorkflowMetadataSchema.safeParse({ linearProject: 'https://notion.so/acme/payouts' }).success,
    ).toBe(false)
  })

  it('rejects a slug with a path separator (workspace/project/subpath)', () => {
    expect(WorkflowMetadataSchema.safeParse({ linearProject: 'acme/payouts/sub' }).success).toBe(false)
  })
})

describe('WorkflowMetadataSchema — severityDefault', () => {
  it('accepts p1-p4', () => {
    for (const s of ['p1', 'p2', 'p3', 'p4'] as const) {
      expect(WorkflowMetadataSchema.safeParse({ severityDefault: s }).success).toBe(true)
    }
  })

  it('rejects unknown severities', () => {
    expect(WorkflowMetadataSchema.safeParse({ severityDefault: 'p5' }).success).toBe(false)
    expect(WorkflowMetadataSchema.safeParse({ severityDefault: 'critical' }).success).toBe(false)
  })

  it('accepts null (explicit clear)', () => {
    expect(WorkflowMetadataSchema.safeParse({ severityDefault: null }).success).toBe(true)
  })
})

describe('WorkflowMetadataSchema — strict (no extra keys)', () => {
  it('rejects unknown top-level fields', () => {
    expect(WorkflowMetadataSchema.safeParse({ extra: 'nope' }).success).toBe(false)
  })
})

describe('UpsertWorkflowMetadataBodySchema', () => {
  it('wraps metadata inside { metadata: ... }', () => {
    const result = UpsertWorkflowMetadataBodySchema.safeParse({
      metadata: { owners: ['alpha'] },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a bare metadata payload at the top level', () => {
    expect(UpsertWorkflowMetadataBodySchema.safeParse({ owners: ['alpha'] }).success).toBe(false)
  })
})

describe('SetWorkflowFolderBodySchema', () => {
  it('accepts a real folder name', () => {
    expect(SetWorkflowFolderBodySchema.safeParse({ folder: 'Billing' }).success).toBe(true)
  })

  it('accepts null (ungroup)', () => {
    expect(SetWorkflowFolderBodySchema.safeParse({ folder: null }).success).toBe(true)
  })

  it('rejects an empty-string folder', () => {
    expect(SetWorkflowFolderBodySchema.safeParse({ folder: '' }).success).toBe(false)
  })

  it(`rejects a folder over ${WORKFLOW_METADATA_FOLDER_MAX_LENGTH} chars`, () => {
    const tooLong = 'x'.repeat(WORKFLOW_METADATA_FOLDER_MAX_LENGTH + 1)
    expect(SetWorkflowFolderBodySchema.safeParse({ folder: tooLong }).success).toBe(false)
  })

  it('requires the folder field (a missing folder is rejected, unlike the optional metadata field)', () => {
    expect(SetWorkflowFolderBodySchema.safeParse({}).success).toBe(false)
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(SetWorkflowFolderBodySchema.safeParse({ folder: 'Billing', extra: 1 }).success).toBe(false)
  })
})

describe('RenameWorkflowFolderBodySchema', () => {
  it('accepts a from/to pair of real names', () => {
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: 'Billing', to: 'Invoicing' }).success).toBe(true)
  })

  it('requires both from and to', () => {
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: 'Billing' }).success).toBe(false)
    expect(RenameWorkflowFolderBodySchema.safeParse({ to: 'Invoicing' }).success).toBe(false)
  })

  it('rejects empty-string names', () => {
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: '', to: 'X' }).success).toBe(false)
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: 'X', to: '' }).success).toBe(false)
  })

  it(`rejects a name over ${WORKFLOW_METADATA_FOLDER_MAX_LENGTH} chars`, () => {
    const tooLong = 'x'.repeat(WORKFLOW_METADATA_FOLDER_MAX_LENGTH + 1)
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: 'Billing', to: tooLong }).success).toBe(false)
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(RenameWorkflowFolderBodySchema.safeParse({ from: 'A', to: 'B', extra: 1 }).success).toBe(false)
  })
})

describe('DeleteWorkflowFolderBodySchema', () => {
  it('accepts a real folder name', () => {
    expect(DeleteWorkflowFolderBodySchema.safeParse({ folder: 'Billing' }).success).toBe(true)
  })

  it('requires the folder field (null is NOT accepted here — there is nothing to delete)', () => {
    expect(DeleteWorkflowFolderBodySchema.safeParse({}).success).toBe(false)
    expect(DeleteWorkflowFolderBodySchema.safeParse({ folder: null }).success).toBe(false)
  })

  it('rejects an empty-string folder', () => {
    expect(DeleteWorkflowFolderBodySchema.safeParse({ folder: '' }).success).toBe(false)
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(DeleteWorkflowFolderBodySchema.safeParse({ folder: 'Billing', extra: 1 }).success).toBe(false)
  })
})
