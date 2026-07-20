/**
 * Composed HTTP route registry — the single ordered `Route[]` the dispatcher
 * iterates first-match-wins.
 *
 * Extracted from `index.ts` so the registry can be imported WITHOUT the boot
 * side effects in `index.ts` (migration assertion, `server.listen`). The
 * web↔route contract test (`routes-contract.test.ts`) imports it to assert
 * every `api(...)` path the web calls resolves to a registered route.
 *
 * Order matters — the dispatcher is first-match-wins; this order mirrors the
 * original monolithic literal so overlap-sensitive pairs
 * (`/workflows/versions` before `/workflows`, `/workflows/health/delta` before
 * `/workflows/health`, `/runs` prefix before `/run?` exact, `/dlq/clusters`
 * before the `/dlq` wildcard) keep their precedence. When adding a feature
 * route array, spread it in the same relative position it needs.
 */

import type { Route } from "./routes";
import { openApiRoutes } from "./openapi-route";

import { aiRoutes } from "./routes/ai-routes";
import { alertsRoutes } from "./routes/alerts-routes";
import { auditRoutes } from "./routes/audit-routes";
import { autoHealingRoutes } from "./routes/auto-healing-routes";
import { billingRoutes } from "./routes/billing-routes";
import { credentialsRoutes } from "./routes/credentials-routes";
import { dlqRoutes } from "./routes/dlq-routes";
import { evalDatasetsRoutes } from "./routes/eval-datasets-routes";
import { experimentsRoutes } from "./routes/experiments-routes";
import { healthRoutes } from "./routes/health-routes";
import { mcpRoutes } from "./routes/mcp-routes";
import { membersRoutes } from "./routes/members-routes";
import { memoryRoutes } from "./routes/memory-routes";
import { onboardingRoutes } from "./routes/onboarding-routes";
import { orgRoutes } from "./routes/org-routes";
import { pluginsRoutes } from "./routes/plugins-routes";
import { promptsRoutes } from "./routes/prompts-routes";
import { recoveryHandoffRoutes } from "./routes/recovery-handoff-routes";
import { recoveryItemsRoutes } from "./routes/recovery-items-routes";
import { recoveryPlaybooksRoutes } from "./routes/recovery-playbooks-routes";
import { recoveryRoutes } from "./routes/recovery-routes";
import { reportsRoutes } from "./routes/reports-routes";
import { rolesRoutes } from "./routes/roles-routes";
import { runsRoutes } from "./routes/runs-routes";
import { scimRoutes } from "./routes/scim-routes";
import { snippetsRoutes } from "./routes/snippets-routes";
import { solutionPacksRoutes } from "./routes/solution-packs-routes";
import { ssoRoutes } from "./routes/sso-routes";
import { templatesRoutes } from "./routes/templates-routes";
import { toolsRoutes } from "./routes/tools-routes";
import { triggerIngestRoutes } from "./routes/trigger-ingest-routes";
import { upstreamHealthRoutes } from "./routes/upstream-health-routes";
import { workflowMetadataRoutes } from "./routes/workflow-metadata-routes";
import { workflowsRoutes } from "./routes/workflows-routes";

export const routes: Route[] = [
  ...openApiRoutes,
  ...healthRoutes,
  ...toolsRoutes,
  ...templatesRoutes,
  ...billingRoutes,
  ...orgRoutes,
  ...memoryRoutes,
  ...membersRoutes,
  ...ssoRoutes,
  ...scimRoutes,
  ...rolesRoutes,
  ...mcpRoutes,
  // Solution packs register before workflows so `POST /workflows/import-pack`
  // resolves here before any `/workflows/*` matcher can shadow it.
  ...solutionPacksRoutes,
  ...onboardingRoutes,
  ...workflowsRoutes,
  ...pluginsRoutes,
  ...credentialsRoutes,
  ...promptsRoutes,
  ...auditRoutes,
  ...recoveryPlaybooksRoutes,
  ...recoveryRoutes,
  ...reportsRoutes,
  ...aiRoutes,
  ...autoHealingRoutes,
  ...alertsRoutes,
  ...recoveryItemsRoutes,
  ...recoveryHandoffRoutes,
  ...workflowMetadataRoutes,
  ...upstreamHealthRoutes,
  ...snippetsRoutes,
  ...evalDatasetsRoutes,
  ...experimentsRoutes,
  ...triggerIngestRoutes,
  ...runsRoutes,
  ...dlqRoutes,
];
