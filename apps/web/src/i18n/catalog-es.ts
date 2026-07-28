/** Spanish runtime catalog. Loaded on demand through `resources.ts`. */
import keys from './locales/en/common.json?janusly-catalog=keys'
import values from './locales/es/common.json?janusly-catalog=values'
import { materializeCatalog } from './compact-catalog'

export default materializeCatalog(keys, values)
