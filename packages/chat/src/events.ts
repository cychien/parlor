export const CHAT_EVENTS = [
  "device_pending",
  "device_rejected",
  "agent_started",
  "agent_exited",
  "agent_switched",
  "host_lost",
  "turn_failed",
  "answer_rejected",
  "answered_on_computer",
] as const;

export type ChatEvent = (typeof CHAT_EVENTS)[number];

export type FoldedEvent = Extract<ChatEvent, "answered_on_computer">;
