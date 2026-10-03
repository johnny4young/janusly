import { vi } from 'vitest'
import { registerExperienceApplyOwnershipCases } from '../test/experience-apply-ownership-cases'
vi.mock('../api', () => ({ api: vi.fn(), contractApi: vi.fn() }))
vi.mock('../components/ConfirmDialog', () => ({ useConfirm: () => async () => true }))
registerExperienceApplyOwnershipCases()
