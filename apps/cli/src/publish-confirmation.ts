export type PublishApprovalResult<T> =
  | { status: "approved"; value: T }
  | { status: "declined" }
  | { status: "requires-yes" };

export interface ConfirmedPublishInput<T> {
  yes: boolean;
  interactive: boolean;
  ask: () => Promise<string>;
  publish: () => Promise<T>;
}

export async function runConfirmedPublish<T>(
  input: ConfirmedPublishInput<T>,
): Promise<PublishApprovalResult<T>> {
  if (input.yes) return { status: "approved", value: await input.publish() };
  if (!input.interactive) return { status: "requires-yes" };

  let answer: string;
  try {
    answer = await input.ask();
  } catch {
    return { status: "declined" };
  }

  answer = answer.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return { status: "declined" };
  return { status: "approved", value: await input.publish() };
}
