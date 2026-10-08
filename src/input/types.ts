export interface ProcessedInput {
  conversationId: string;
  userId: string;
  content: string;
  source: "text" | "voice" | "document";
  requiresAudioReply: boolean;
  voiceId?: string;
}