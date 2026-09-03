export type HarvestedMessage = {
  source: "cursor" | "chatgpt";
  conversationId: string;
  messageId?: string;
  conversationTitle?: string;
  workspace?: string;
  timestamp?: string;
  role: "user" | "assistant";
  content: string;
};

export type HarvestState = {
  version: 1;
  cursor: {
    files: Record<string, { offset: number }>;
  };
  chatgpt: {
    conversations: Record<string, { messageIds: string[] }>;
  };
  lastSuccessfulHarvestAt?: string;
};

export type SourceStats = {
  conversationCount: number;
  messageCount: number;
};

export type HarvestCollectOptions = {
  sinceMs?: number;
  /** First run: checkpoint every discovered source even if nothing was archived from it. */
  sealAll: boolean;
  /** When false, propose checkpoints without returning messages. */
  includeMessages: boolean;
};

export function emptyHarvestState(): HarvestState {
  return {
    version: 1,
    cursor: { files: {} },
    chatgpt: { conversations: {} },
  };
}

export function sourceStats(messages: HarvestedMessage[]): SourceStats {
  const conversations = new Set(messages.map((m) => m.conversationId));
  return {
    conversationCount: conversations.size,
    messageCount: messages.length,
  };
}

export function sortMessages(messages: HarvestedMessage[]): HarvestedMessage[] {
  return [...messages].sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp);
    }
    if (a.timestamp && !b.timestamp) return -1;
    if (!a.timestamp && b.timestamp) return 1;
    return 0;
  });
}
