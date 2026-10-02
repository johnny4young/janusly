import { vi } from 'vitest'
import { registerVersionHistoryOwnershipCases } from '../test/version-history-ownership-cases'
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), contractApi: vi.fn(), api: vi.fn() }))
registerVersionHistoryOwnershipCases()
