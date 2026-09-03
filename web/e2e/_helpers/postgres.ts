import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url))

/**
 * Execute fixture SQL against the repository's disposable Compose database.
 * Keep the defaults aligned with docker-compose.yml while allowing isolated
 * qualification profiles to override the database identity explicitly.
 */
export async function execPostgresSql(sql: string): Promise<void> {
  const user = process.env.JANUSLY_E2E_POSTGRES_USER ?? 'janusly'
  const database = process.env.JANUSLY_E2E_POSTGRES_DB ?? 'janusly'
  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ])
}
