export const TELEGRAM_MAX_LENGTH = 4096;

export function truncateResult(text: string, taskId: string): string {
  const footer = `\n\n---\nFull result: tasks/${taskId}/result in Munin`;
  const maxContent = TELEGRAM_MAX_LENGTH - footer.length - 10;
  if (text.length <= maxContent) return text + footer;
  return text.slice(0, maxContent) + "..." + footer;
}
