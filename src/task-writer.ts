import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { signTask } from "./task-signing.js";

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

const SAFE_REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;

function validateRepoContext(context: string): string | null {
  if (context === "scratch") return null;

  if (!context.startsWith("repo:")) {
    throw new Error(`Invalid task context: ${JSON.stringify(context)}`);
  }

  const repoName = context.slice("repo:".length);
  if (!SAFE_REPO_NAME.test(repoName)) {
    throw new Error(`Invalid repo context: ${JSON.stringify(context)}`);
  }
  if (!config.allowedRepos.includes(repoName)) {
    throw new Error(`Repo is not allowed for Ratatoskr tasks: ${repoName}`);
  }
  return repoName;
}

function resolveWorkingDirectory(context: string): string | null {
  const repoName = validateRepoContext(context);
  return repoName ? `${config.reposBasePath}/${repoName}` : null;
}

interface FormattedTask {
  content: string;
  taskId: string;
}

function formatTaskMarkdown(taskId: string, submission: TaskSubmission, submittedAt: string): FormattedTask {
  const workdir = resolveWorkingDirectory(submission.context);
  const prompt = workdir
    ? `Working directory: ${workdir}\n\n${submission.prompt}`
    : submission.prompt;
  const runtime = "claude";
  const submitter = "ratatoskr";

  const header = `## Task

**Runtime:** ${runtime}
**Context:** ${submission.context}
**Timeout:** ${submission.timeout * 1000}
**Submitted by:** ${submitter}
**Submitted at:** ${submittedAt}
**Reply-to:** telegram:${submission.chatId}`;

  const signature = config.signingSecret
    ? signTask(
        {
          taskId,
          submitter,
          submittedAt,
          runtime,
          prompt,
        },
        config.signingKeyId,
        config.signingSecret,
      )
    : null;

  const signatureLine = signature ? `\n**Signature:** ${signature}` : "";

  const content = `${header}${signatureLine}

### Prompt

${prompt}
`;

  return { content, taskId };
}

export async function submitTask(
  submission: TaskSubmission,
  munin: MuninClient
): Promise<string> {
  const taskId = generateTaskId(submission.title);
  const submittedAt = new Date().toISOString();
  const { content } = formatTaskMarkdown(taskId, submission, submittedAt);

  await munin.write(`tasks/${taskId}`, "status", content, [
    "pending",
    "runtime:claude",
    `instance:${config.instanceId}`,
  ]);

  return taskId;
}
