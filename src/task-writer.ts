import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";

export interface TaskSubmission {
  title: string;
  prompt: string;
  context: string;
  timeout: number;
  chatId: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function generateTaskId(title: string): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${date}-${time}-${slugify(title)}`;
}

function resolveWorkingDirectory(context: string): string | null {
  const match = context.match(/^repo:(.+)$/);
  if (match) {
    return `${config.reposBasePath}/${match[1]}`;
  }
  return null;
}

function formatTaskMarkdown(submission: TaskSubmission): string {
  const now = new Date().toISOString();
  const workdir = resolveWorkingDirectory(submission.context);
  const prompt = workdir
    ? `Working directory: ${workdir}\n\n${submission.prompt}`
    : submission.prompt;

  return `## Task

**Runtime:** claude
**Context:** ${submission.context}
**Timeout:** ${submission.timeout * 1000}
**Submitted by:** ratatoskr
**Submitted at:** ${now}
**Reply-to:** telegram:${submission.chatId}

### Prompt

${prompt}
`;
}

export async function submitTask(
  submission: TaskSubmission,
  munin: MuninClient
): Promise<string> {
  const taskId = generateTaskId(submission.title);
  const content = formatTaskMarkdown(submission);

  await munin.write(`tasks/${taskId}`, "status", content, [
    "pending",
    "runtime:claude",
    `instance:${config.instanceId}`,
  ]);

  return taskId;
}
