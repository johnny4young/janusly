import { expectTypeOf, it } from 'vitest'
import type { ApiResponses } from './api-types.generated'
import type { NodeStatus, RunStatus } from './status'

it('generates required run projections and nullable metadata from one wire contract', () => {
  type Snapshot = ApiResponses['GET /status']
  expectTypeOf<Snapshot>().toEqualTypeOf<ApiResponses['GET /run']>()
  expectTypeOf<Snapshot['run']['status']>().toEqualTypeOf<RunStatus>()
  expectTypeOf<Snapshot['nodes'][number]['status']>().toEqualTypeOf<NodeStatus>()
  expectTypeOf<Snapshot['run']['createdAt']>().toEqualTypeOf<string | null>()
  expectTypeOf<Snapshot['events'][number]['createdAt']>().toEqualTypeOf<string | null>()
  expectTypeOf<Snapshot['nodes'][number]['attempts']>().toEqualTypeOf<number | null>()
  expectTypeOf<Snapshot['eventsHasMore']>().toEqualTypeOf<boolean>()
  expectTypeOf<Snapshot['eventsCursor']>().toEqualTypeOf<string | null>()
})
