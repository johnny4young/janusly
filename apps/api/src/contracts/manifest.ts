/** Pure, side-effect-free manifest consumed by runtime aliasing and OpenAPI tooling. */

import type { ApiContractRouteDescriptor } from "../api-contract-types";
import { generateWorkflowContract, patchWorkflowContract } from "./ai";
import { listTemplatesContract, listToolsContract } from "./catalog";
import { listDeadLettersContract, listFailureClustersContract, replayDeadLetterContract } from "./dlq";
import {
  createMcpConnectionContract,
  deleteMcpConnectionContract,
  listMcpConnectionsContract,
  listMcpConnectionToolsContract,
  rediscoverMcpConnectionContract,
  setMcpConnectionToolContract,
  updateMcpConnectionContract,
} from "./mcp";
import {
  getRecoveryCaseContract,
  listRecoveryCasesContract,
  memoryConsentStatusContract,
  recoverSemanticCaseContract,
  recoveryLedgerContract,
  recoveryMetricsContract,
  recoveryMyWinsContract,
} from "./recovery";
import { getRunExplainReportContract } from "./reports";
import {
  cancelRunContract,
  getRunContract,
  getRunStatusContract,
  getRunUsageContract,
  listRunsContract,
  redriveRunContract,
  resumeRunContract,
  startRunContract,
} from "./runs";
import {
  checkWorkflowReadinessContract,
  getLatestWorkflowVersionContract,
  getSchedulePreviewContract,
  getWorkflowHealthContract,
  listWorkflowVersionsContract,
  listWorkflowsContract,
  resumeWorkflowContract,
  rollbackWorkflowContract,
  saveWorkflowContract,
  validateWorkflowContract,
} from "./workflows";

/**
 * Side-effect-free contract manifest. The generator imports this instead of
 * the handler registry so contract checks never create Redis/DB clients.
 * A registry contract test pins parity with the real route entries.
 */
export const V1_CONTRACT_ROUTES: readonly ApiContractRouteDescriptor[] = [
  { method: "GET", role: "viewer", permission: "recovery.read", contract: memoryConsentStatusContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryMetricsContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryLedgerContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryMyWinsContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: listRecoveryCasesContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: getRecoveryCaseContract },
  { method: "POST", role: "editor", permission: "recovery.write", contract: recoverSemanticCaseContract },
  { method: "GET", contract: listTemplatesContract },
  { method: "GET", contract: listToolsContract },
  { method: "POST", permission: "ai.write", contract: generateWorkflowContract },
  { method: "POST", role: "editor", permission: "ai.write", contract: patchWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: validateWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: checkWorkflowReadinessContract },
  { method: "GET", role: "viewer", permission: "workflows.read", contract: getWorkflowHealthContract },
  { method: "GET", role: "viewer", permission: "reports.read", contract: getRunExplainReportContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: saveWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: rollbackWorkflowContract },
  { method: "GET", role: "viewer", permission: "dlq.read", contract: listDeadLettersContract },
  { method: "GET", role: "viewer", permission: "dlq.read", contract: listFailureClustersContract },
  { method: "POST", role: "editor", permission: "dlq.replay", contract: replayDeadLetterContract },
  { method: "GET", contract: listWorkflowsContract },
  { method: "GET", role: "viewer", permission: "workflows.read", contract: getSchedulePreviewContract },
  { method: "GET", contract: listWorkflowVersionsContract },
  { method: "GET", contract: getLatestWorkflowVersionContract },
  { method: "GET", contract: listRunsContract },
  { method: "GET", contract: getRunContract },
  { method: "GET", permission: "runs.read", contract: getRunUsageContract },
  { method: "GET", contract: getRunStatusContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: redriveRunContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: startRunContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: resumeRunContract },
  { method: "POST", role: "editor", permission: "runs.cancel", contract: cancelRunContract },
  { method: "POST", permission: "workflows.write", contract: resumeWorkflowContract },
  { method: "GET", role: "viewer", permission: "mcp.connections.read", contract: listMcpConnectionsContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: createMcpConnectionContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: updateMcpConnectionContract },
  { method: "DELETE", role: "admin", permission: "mcp.connections.write", contract: deleteMcpConnectionContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: rediscoverMcpConnectionContract },
  { method: "GET", role: "viewer", permission: "mcp.connections.read", contract: listMcpConnectionToolsContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: setMcpConnectionToolContract },
];
