/** API translation for the always-visible MCP surface. */

import { V1_MCP_PATHS, V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { runStatusValues } from "@janusly/shared/src/status";
import type { CallApi } from "../api-client";
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireMcpAlias,
  requireString,
} from "./arguments";
import { isObject, v1 } from "./shared";

const DLQ_STATUSES = ["open", "replayed", "resolved"] as const;
const DLQ_SEVERITIES = ["p1", "p2", "p3", "p4"] as const;
const DLQ_SORTS = ["newest", "oldest", "severity", "sla"] as const;
const RUN_KINDS = ["production", "validation"] as const;

export async function dispatchVisibleTool(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "workflows.list": {
      const params = new URLSearchParams();
      const limit = optionalInteger(args.limit, "workflows.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const tags = optionalStringArray(args.tag, "workflows.list `tag`", 20, 40);
      for (const tag of tags ?? []) params.append("tag", tag);
      const folder = optionalString(args.folder, "workflows.list `folder`", 60);
      if (folder !== undefined) params.set("folder", folder);
      const search = optionalString(args.q, "workflows.list `q`", 100);
      if (search !== undefined) params.set("q", search);
      const before = optionalString(args.before, "workflows.list `before`", 512, 3);
      if (before !== undefined) params.set("before", before);
      const query = params.toString();
      const path = v1(V1_READ_PATHS.workflows);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "workflows.get": {
      const workflowId = requireString(args.workflowId, "workflows.get `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.latestWorkflowVersion)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "recipes.list":
      return callApi(v1(V1_READ_PATHS.templates));
    case "tools.list":
      return callApi(v1(V1_READ_PATHS.tools));
    case "memory.consent_status":
      return callApi(v1(V1_READ_PATHS.memoryConsentStatus));
    case "recovery.ledger":
      return callApi(v1(V1_READ_PATHS.recoveryLedger));
    case "recovery.my_wins": {
      const days = optionalInteger(args.days, "recovery.my_wins `days`", 1, 90);
      const path = v1(V1_READ_PATHS.recoveryMyWins);
      return callApi(days === undefined ? path : `${path}?days=${days}`);
    }
    case "recovery.cases.list": {
      const params = new URLSearchParams();
      const openOnly = optionalBoolean(
        args.openOnly,
        "recovery.cases.list `openOnly`",
      );
      if (openOnly !== undefined) params.set("openOnly", String(openOnly));
      const runId = optionalString(
        args.runId,
        "recovery.cases.list `runId`",
        256,
      );
      if (runId !== undefined) params.set("runId", runId);
      const limit = optionalInteger(
        args.limit,
        "recovery.cases.list `limit`",
        1,
        200,
      );
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.recoveryCases);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "recovery.cases.get": {
      const caseId = requireString(
        args.caseId,
        "recovery.cases.get `caseId`",
        256,
      );
      return callApi(
        v1(V1_READ_PATHS.recoveryCase)
          .replace("{caseId}", encodeURIComponent(caseId)),
      );
    }
    case "runs.get": {
      const runId = requireString(args.runId, "runs.get `runId`", 256);
      const params = new URLSearchParams({ runId });
      const eventsLimit = optionalInteger(args.eventsLimit, "runs.get `eventsLimit`", 1, 500);
      if (eventsLimit !== undefined) params.set("eventsLimit", String(eventsLimit));
      const eventsCursor = optionalString(args.eventsCursor, "runs.get `eventsCursor`", 512, 3);
      if (eventsCursor !== undefined) params.set("eventsCursor", eventsCursor);
      return callApi(`${v1(V1_READ_PATHS.run)}?${params.toString()}`);
    }
    case "workflows.validate": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.validate requires `workflow` (object)");
      }
      return callApi(v1(V1_WRITE_PATHS.validateWorkflow), {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.versions": {
      const workflowId = requireString(args.workflowId, "workflows.versions `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.workflowVersions)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "workflows.health": {
      const workflowId = requireString(args.workflowId, "workflows.health `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.workflowHealth)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "workflows.readiness": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.readiness requires `workflow` (object)");
      }
      return callApi(v1(V1_WRITE_PATHS.workflowReadiness), {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.schedule_preview": {
      const cron = optionalString(args.cron, "workflows.schedule_preview `cron`", 100);
      if (cron === undefined) {
        throw new Error("workflows.schedule_preview `cron` is required");
      }
      const params = new URLSearchParams({ cron });
      return callApi(`${v1(V1_READ_PATHS.schedulePreview)}?${params.toString()}`);
    }
    case "runs.list": {
      const params = new URLSearchParams();
      const workflowId = optionalString(args.workflowId, "runs.list `workflowId`", 512);
      if (workflowId !== undefined) params.set("workflowId", workflowId);
      const limit = optionalInteger(args.limit, "runs.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const status = optionalEnum(args.status, "runs.list `status`", runStatusValues);
      if (status !== undefined) params.set("status", status);
      const runKind = optionalEnum(args.runKind, "runs.list `runKind`", RUN_KINDS);
      if (runKind !== undefined) params.set("runKind", runKind);
      const before = optionalString(args.before, "runs.list `before`", 512, 3);
      if (before !== undefined) params.set("before", before);
      const query = params.toString();
      const path = v1(V1_READ_PATHS.runs);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "runs.status": {
      const runId = requireString(args.runId, "runs.status `runId`", 256);
      const params = new URLSearchParams({ runId });
      const eventsLimit = optionalInteger(args.eventsLimit, "runs.status `eventsLimit`", 1, 500);
      if (eventsLimit !== undefined) params.set("eventsLimit", String(eventsLimit));
      return callApi(`${v1(V1_READ_PATHS.runStatus)}?${params.toString()}`);
    }
    case "runs.usage": {
      const runId = requireString(args.runId, "runs.usage `runId`", 256);
      return callApi(`${v1(V1_READ_PATHS.runUsage)}?runId=${encodeURIComponent(runId)}`);
    }
    case "dlq.list": {
      const params = new URLSearchParams();
      const status = optionalEnum(args.status, "dlq.list `status`", DLQ_STATUSES);
      if (status !== undefined) params.set("status", status);
      const severity = optionalEnum(args.severity, "dlq.list `severity`", DLQ_SEVERITIES);
      if (severity !== undefined) params.set("severity", severity);
      const sort = optionalEnum(args.sort, "dlq.list `sort`", DLQ_SORTS);
      if (sort !== undefined) params.set("sort", sort);
      const owner = optionalString(args.owner, "dlq.list `owner`", 200);
      if (owner !== undefined) params.set("owner", owner);
      const search = optionalString(args.search, "dlq.list `search`", 100);
      if (search !== undefined) params.set("search", search);
      const limit = optionalInteger(args.limit, "dlq.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.deadLetters);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "dlq.clusters": {
      const params = new URLSearchParams();
      const windowDays = optionalInteger(args.windowDays, "dlq.clusters `windowDays`", 1, 90);
      if (windowDays !== undefined) params.set("windowDays", String(windowDays));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.failureClusters);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "recovery.metrics": {
      const params = new URLSearchParams();
      const windowDays = optionalInteger(args.windowDays, "recovery.metrics `windowDays`", 1, 90);
      if (windowDays !== undefined) params.set("windowDays", String(windowDays));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.recoveryMetrics);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "reports.run_explain": {
      const runId = requireString(args.runId, "reports.run_explain `runId`", 256);
      const params = new URLSearchParams({ runId, format: "json" });
      return callApi(`${v1(V1_READ_PATHS.runExplainReport)}?${params.toString()}`);
    }
    case "ai.patch_workflow": {
      const deadLetterId = requireString(
        args.deadLetterId,
        "ai.patch_workflow `deadLetterId`",
        256,
      );
      return callApi(v1(V1_WRITE_PATHS.patchWorkflow), {
        method: "POST",
        body: JSON.stringify({ deadLetterId }),
      });
    }
    case "ai.generate_workflow": {
      const prompt = requireString(args.prompt, "ai.generate_workflow `prompt`", 20_000);
      return callApi(v1(V1_WRITE_PATHS.generateWorkflow), {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
    }
    case "mcp.connections.list":
      return callApi(v1(V1_MCP_PATHS.connections));
    case "mcp.connections.tools": {
      const alias = requireMcpAlias(args.alias, name);
      return callApi(v1(V1_MCP_PATHS.connectionTools)
        .replace("{alias}", encodeURIComponent(alias)));
    }
    default:
      throw new Error(`Unknown always-visible MCP tool: ${name}`);
  }
}
