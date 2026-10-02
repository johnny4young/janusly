/** UI metadata shared with the unchanged request validators. */

export const RECOVERY_HANDOFF_DESTINATIONS = ['slack', 'linear', 'github', 'webhook'] as const

export type RecoveryHandoffDestination = (typeof RECOVERY_HANDOFF_DESTINATIONS)[number]
