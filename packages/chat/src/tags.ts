/** Every chat write emits `["parlor_chat", threadId]`, the one event that wakes hosts and other devices. */
export const CHAT_TAG = "parlor_chat";
/** Emitted when a computer comes, goes or changes its agents. */
export const HOSTS_TAG = "parlor_chat_hosts";
/** Emitted when a signed-in tab is in use, carrying no thread, item or text; it wakes no host's claim loop. */
export const CHAT_ACTIVITY_TAG = "parlor_chat_activity";
