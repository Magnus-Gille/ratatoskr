import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";

export type TriageResult =
  | {
      action: "ready";
      task: { prompt: string; context: string; timeout: number; title: string };
    }
  | { action: "clarify"; question: string }
  | { action: "answer"; reply: string };

const SYSTEM_PROMPT = `You are a concierge for a personal AI infrastructure called Grimnir. You triage messages from the owner (Magnus) sent via Telegram on his phone. Messages may be terse.

You have context from Munin (the memory system) about active projects and tasks.

Your job: decide what to do with each message.

Respond with JSON only. One of three actions:

1. **ready** — The intent is clear enough to submit as a Hugin task.
   {"action": "ready", "task": {"prompt": "<enriched prompt for Claude Code>", "context": "<repo:name or scratch>", "timeout": <seconds>, "title": "<short slug>"}}
   - Enrich terse messages into clear prompts (e.g. "fix the css bug" → "Fix the CSS layout bug in the navbar component that was reported yesterday")
   - Use Munin context to fill in details the user left implicit — but if the repo, bug, or target is genuinely uncertain, prefer "clarify" over guessing
   - context should be "repo:<name>" for repo work, "scratch" for general tasks
   - timeout: 300 for quick fixes, 600 for moderate tasks, 1800 for large tasks

2. **clarify** — The message is ambiguous, you need more info.
   {"action": "clarify", "question": "<your question>"}

3. **answer** — Can be answered directly from context without a task.
   {"action": "answer", "reply": "<your reply>"}
   - Use for status checks, quick facts from Munin context, greetings, etc.

When asking clarification questions, be casual and terse — this is a phone conversation.
Example: "Which bug? The Heimdall CSS one from yesterday or the backup script?"
NOT: "Could you please clarify which bug you are referring to?"

Always respond with valid JSON, no markdown fences.`;

export async function gatherContext(
  munin: MuninClient
): Promise<string> {
  const parts: string[] = [];

  try {
    const activeTasks = await munin.query({
      query: "task",
      namespace: "tasks/",
      tags: ["running"],
      limit: 3,
    });
    if (activeTasks.results.length > 0) {
      parts.push(
        "## Running tasks\n" +
          activeTasks.results
            .map(
              (r) =>
                `- ${r.namespace}/${r.key}: ${r.content_preview.slice(0, 100)}`
            )
            .join("\n")
      );
    }
  } catch {
    // Munin query failed — continue without this context
  }

  try {
    const recentProjects = await munin.query({
      query: "recent activity",
      namespace: "projects/",
      limit: 5,
    });
    if (recentProjects.results.length > 0) {
      parts.push(
        "## Recent project activity\n" +
          recentProjects.results
            .map(
              (r) =>
                `- ${r.namespace}: ${r.content_preview.slice(0, 120)}`
            )
            .join("\n")
      );
    }
  } catch {
    // Continue without project context
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "No recent context available from Munin.";
}

export async function triage(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  muninContext: string
): Promise<TriageResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: message },
  ];

  const response = await client.messages.create({
    model: config.conciergeModel,
    max_tokens: 1024,
    system: `${SYSTEM_PROMPT}\n\n## Current Munin Context\n${muninContext}`,
    messages,
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Strip markdown fences if Haiku wraps them anyway
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  // Validate structure
  if (parsed.action === "ready" && parsed.task?.prompt && parsed.task?.title) {
    return {
      action: "ready",
      task: {
        prompt: parsed.task.prompt,
        context: parsed.task.context || "scratch",
        timeout: parsed.task.timeout || 600,
        title: parsed.task.title,
      },
    };
  } else if (parsed.action === "clarify" && parsed.question) {
    return { action: "clarify", question: parsed.question };
  } else if (parsed.action === "answer" && parsed.reply) {
    return { action: "answer", reply: parsed.reply };
  }

  // Fallback: treat as answer if we got something
  if (parsed.reply || parsed.question) {
    return {
      action: "answer",
      reply: parsed.reply || parsed.question || "I couldn't parse that.",
    };
  }

  throw new Error(`Unexpected concierge response: ${text}`);
}
