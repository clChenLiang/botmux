import type { MessageResource } from './message-parser.js';

export function composeForwardFollowupContent(seedContent: string, followupContent: string): string {
  const seed = seedContent.trim();
  const followup = followupContent.trim();
  if (!seed) return followup;
  if (!followup) return seed;
  return '<forwarded_context>\n' + seed + '\n</forwarded_context>\n\n'
    + '<user_request>\n' + followup + '\n</user_request>';
}

export function bindResourcesToMessage(
  resources: MessageResource[],
  messageId: string,
): MessageResource[] {
  return resources.map(resource => ({
    ...resource,
    messageId: resource.messageId ?? messageId,
  }));
}
