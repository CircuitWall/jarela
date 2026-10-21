export interface FirstRunContext {
  userName: string;
  about: string;
  starterGoal: string;
  assistantName: string;
  modelProvider: string;
  modelName: string;
}

export function buildFirstRunKickoff({
  userName,
  about,
  starterGoal,
  assistantName,
  modelProvider,
  modelName,
}: FirstRunContext): string {
  const context = [
    `I'm ${userName.trim()}.`,
    about.trim() ? `A little about me: ${about.trim()}` : null,
    `I named you ${assistantName.trim()}.`,
    `We're starting with ${modelProvider} ${modelName}.`,
    starterGoal.trim() ? `My first goal is: ${starterGoal.trim()}` : null,
  ].filter((line): line is string => line !== null).join("\n");

  return [
    context,
    "Let's make this work well for me. Please start with a brief, natural summary of what is ready for us, then ask me one thoughtful question about my role or day-to-day.",
  ].join("\n\n");
}

export function buildFirstRunAgentInstructions(starterGoal: string): string {
  const startingInstructions = starterGoal.trim()
    ? starterGoal.trim()
    : "Help me with practical tasks, and ask concise questions when you need more context.";

  return [
    startingInstructions,
    "When I ask to personalize how you work, ask a few concise questions about my role, priorities, and communication preferences. Skip anything I have already shared.",
    "After I answer, summarize what you learned and show me a short draft of your standing instructions. Ask me to approve or revise it. Never change saved instructions without my explicit approval. After I approve, use update_agent_instruction to save the agreed draft. If that tool is unavailable, leave the draft in chat and tell me where I can update it.",
    "Keep internal setup actions and tool details out of your replies. Tell me what is ready, then continue the conversation naturally. Once we've personalized your instructions, suggest a few practical first tasks based on what I shared.",
  ].join("\n\n");
}