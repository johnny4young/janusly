import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalProviderMode } from "./local-provider-mode.mjs";

test("simulator mode selects only bundled provider references", () => {
  assert.deepEqual(resolveLocalProviderMode({
    JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
    JANUSLY_MAILER_PROVIDER: "resend",
  }), {
    simulatorEnabled: true,
    credentialRefs: {
      github: "JANUSLY_LOCAL_GITHUB_TOKEN",
      slack: "JANUSLY_LOCAL_SLACK_WEBHOOK_URL",
      webhook: "JANUSLY_LOCAL_WEBHOOK_SECRET",
    },
    emailProvider: "simulator",
  });
});

test("external mode selects explicit runtime secret references", () => {
  assert.deepEqual(resolveLocalProviderMode({
    JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "false",
    JANUSLY_MAILER_PROVIDER: "resend",
  }), {
    simulatorEnabled: false,
    credentialRefs: {
      github: "GITHUB_TOKEN",
      slack: "SLACK_WEBHOOK_URL",
      webhook: "WEBHOOK_SIGNING_SECRET",
    },
    emailProvider: "resend",
  });
});

test("external mode never retains the simulator mailer accidentally", () => {
  assert.equal(resolveLocalProviderMode({
    JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "false",
    JANUSLY_MAILER_PROVIDER: "simulator",
  }).emailProvider, "noop");
  assert.equal(resolveLocalProviderMode({
    JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "false",
    JANUSLY_MAILER_PROVIDER: "unknown",
  }).emailProvider, "noop");
});
