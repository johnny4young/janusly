import { describe, expect, it } from "vitest";

import {
  buildSlackRecoveryBlocks,
  SLACK_ACTION_ACKNOWLEDGE,
  SLACK_ACTION_ASSIGN_TO_ME,
  SLACK_ACTION_OPEN,
} from "./slack-actions";

describe("buildSlackRecoveryBlocks", () => {
  it("builds acknowledge, assign, and safe deep-link buttons", () => {
    const blocks = buildSlackRecoveryBlocks({
      trigger: "recovery_item.created",
      markdown: "**Recovery item**",
      payload: { itemId: "item-1" },
      deepLinkUrl: "https://janusly.example/operations?recoveryItemId=item-1",
    });
    expect(blocks).toHaveLength(2);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain(SLACK_ACTION_ACKNOWLEDGE);
    expect(serialized).toContain(SLACK_ACTION_ASSIGN_TO_ME);
    expect(serialized).toContain(SLACK_ACTION_OPEN);
    expect(serialized).toContain("item-1");
  });

  it("omits blocks for unrelated triggers, missing item ids, or unsafe links", () => {
    expect(buildSlackRecoveryBlocks({
      trigger: "budget.blocked",
      markdown: "Budget",
      payload: { itemId: "item-1" },
      deepLinkUrl: null,
    })).toBeNull();
    expect(buildSlackRecoveryBlocks({
      trigger: "recovery_item.created",
      markdown: "Recovery",
      payload: {},
      deepLinkUrl: null,
    })).toBeNull();
    const blocks = buildSlackRecoveryBlocks({
      trigger: "recovery_item.sla_breached",
      markdown: "Recovery",
      payload: { itemId: "item-1" },
      deepLinkUrl: "javascript:alert(1)",
    });
    expect(JSON.stringify(blocks)).not.toContain(SLACK_ACTION_OPEN);
  });
});
