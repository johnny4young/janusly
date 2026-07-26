import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../deploy/observability/", import.meta.url);

async function load(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("local observability profile pins every image and loopback-publishes services", async () => {
  const compose = await load("compose.local.yml");
  const images = [...compose.matchAll(/^\s+image:\s+(\S+)$/gm)].map((match) => match[1]);

  assert.deepEqual(images, [
    "grafana/alloy:v1.16.1",
    "prom/prometheus:v3.11.0",
    "grafana/tempo:2.10.5",
    "grafana/grafana:13.1.0",
  ]);
  assert.equal(images.some((image) => image.endsWith(":latest")), false);
  for (const port of ["12345", "4318", "9090", "3200", "3000"]) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:${port}`));
  }
  assert.match(compose, /GF_PLUGINS_PREINSTALL_DISABLED:\s+"true"/);
  assert.match(compose, /GF_ANALYTICS_REPORTING_ENABLED:\s+"false"/);
});

test("Alloy profiles scrape both Janusly processes and use OTLP", async () => {
  for (const profile of ["alloy/local.alloy", "alloy/cloud.alloy"]) {
    const config = await load(profile);
    assert.match(config, /host\.docker\.internal:9464/);
    assert.match(config, /host\.docker\.internal:9465/);
    assert.match(config, /otelcol\.receiver\.otlp/);
    assert.doesNotMatch(config, /jaeger/i);
  }
});

test("starter dashboard and rules cover the operational baseline", async () => {
  const dashboard = JSON.parse(await load("grafana/dashboards/janusly-operations.json"));
  const expressions = dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => target.expr),
  );
  const expressionText = expressions.join("\n");

  assert.equal(dashboard.uid, "janusly-operations");
  assert.equal(dashboard.title, "Janusly Operations");
  assert.equal(dashboard.panels.length, 7);
  for (const metric of [
    "workflow_queue_waiting_jobs",
    "maintenance_queue_waiting_jobs",
    "janusly_rate_limit_degraded_buckets",
    "workflow_node_failures_total",
    "workflow_node_duration_ms_bucket",
  ]) {
    assert.match(expressionText, new RegExp(metric));
  }

  const rules = await load("prometheus/rules.yml");
  for (const alert of [
    "JanuslyApiMetricsMissing",
    "JanuslyWorkerMetricsMissing",
    "JanuslyWorkflowQueueWaiting",
    "JanuslyMaintenanceQueueWaiting",
    "JanuslyRateLimiterDegraded",
    "JanuslyNodeFailuresDetected",
  ]) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
});

test("cloud profile requires credentials without committing a real token", async () => {
  const compose = await load("compose.cloud.yml");
  const example = await load("cloud.env.example");

  assert.match(compose, /GRAFANA_CLOUD_API_TOKEN:\s+\$\{GRAFANA_CLOUD_API_TOKEN:\?/);
  assert.match(example, /GRAFANA_CLOUD_API_TOKEN=replace-with-a-cloud-access-policy-token/);
  assert.doesNotMatch(example, /glc_[A-Za-z0-9+/=_-]{20,}/);
});
