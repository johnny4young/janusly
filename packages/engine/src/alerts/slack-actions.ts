/**
 * Pure Slack Block Kit projection for actionable recovery alerts.
 *
 * Used by `alerts/dispatcher.ts` only after it has confirmed that the alert's
 * optional interaction connection is enabled for the same organization.
 * The callback URL is configured once in Slack and is deliberately absent
 * from outbound blocks; opaque item ids are the only action values.
 */

import {
  SLACK_ACTION_ACKNOWLEDGE,
  SLACK_ACTION_ASSIGN_TO_ME,
  SLACK_ACTION_OPEN,
  type AlertTrigger,
} from "@janusly/shared";

export { SLACK_ACTION_ACKNOWLEDGE, SLACK_ACTION_ASSIGN_TO_ME, SLACK_ACTION_OPEN };

const MARKDOWN_MAX = 2_900;
const ACTION_VALUE_MAX = 256;

function validUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Build bounded action blocks only for a recovery item with a stable id. */
export function buildSlackRecoveryBlocks(input: {
  trigger: AlertTrigger;
  markdown: string;
  payload: Record<string, unknown>;
  deepLinkUrl: string | null;
}): Array<Record<string, unknown>> | null {
  if (input.trigger !== "recovery_item.created" && input.trigger !== "recovery_item.sla_breached") {
    return null;
  }
  const itemId = input.payload.itemId;
  if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > ACTION_VALUE_MAX) {
    return null;
  }
  const elements: Array<Record<string, unknown>> = [
    {
      type: "button",
      text: { type: "plain_text", text: "Acknowledge", emoji: true },
      style: "primary",
      action_id: SLACK_ACTION_ACKNOWLEDGE,
      value: itemId,
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Assign to me", emoji: true },
      action_id: SLACK_ACTION_ASSIGN_TO_ME,
      value: itemId,
    },
  ];
  const url = validUrl(input.deepLinkUrl);
  if (url) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Open in Janusly", emoji: true },
      action_id: SLACK_ACTION_OPEN,
      value: itemId,
      url,
    });
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: input.markdown.slice(0, MARKDOWN_MAX) } },
    { type: "actions", elements },
  ];
}
