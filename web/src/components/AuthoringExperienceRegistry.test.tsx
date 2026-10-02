import { vi } from 'vitest'
import { registerExperienceRegistryCases } from '../test/experience-registry-cases'
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), contractApi: vi.fn() }))
registerExperienceRegistryCases()
