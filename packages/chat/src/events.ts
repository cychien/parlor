export const CHAT_EVENTS = [
  "device_pending",
  "device_rejected",
  "agent_started",
  "agent_exited",
  "agent_switched",
  "host_lost",
  "turn_failed",
  "answer_rejected",
] as const;

export type ChatEvent = (typeof CHAT_EVENTS)[number];
