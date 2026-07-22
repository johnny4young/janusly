/** Resolves the safe provider posture for the persistent local stack. */

const externalMailerProviders = new Set(["noop", "resend", "sendgrid"]);

export function resolveLocalProviderMode(environment = process.env) {
  const simulatorEnabled = environment.JANUSLY_LOCAL_INTEGRATION_SIMULATOR === "true";
  const requestedMailer = environment.JANUSLY_MAILER_PROVIDER?.trim().toLowerCase();

  return {
    simulatorEnabled,
    credentialRefs: simulatorEnabled
      ? {
          github: "JANUSLY_LOCAL_GITHUB_TOKEN",
          slack: "JANUSLY_LOCAL_SLACK_WEBHOOK_URL",
          webhook: "JANUSLY_LOCAL_WEBHOOK_SECRET",
        }
      : {
          github: "GITHUB_TOKEN",
          slack: "SLACK_WEBHOOK_URL",
          webhook: "WEBHOOK_SIGNING_SECRET",
        },
    emailProvider: simulatorEnabled
      ? "simulator"
      : requestedMailer && externalMailerProviders.has(requestedMailer)
        ? requestedMailer
        : "noop",
  };
}
