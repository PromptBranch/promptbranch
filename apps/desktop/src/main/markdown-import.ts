import { randomUUID } from "node:crypto";
import type { PromptLibrary } from "@promptbranch/core";
import { uniqueImportTitle } from "@promptbranch/share";
import { fetchPublicMarkdown, type PublicMarkdownResult } from "./public-markdown.js";

const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_TITLE_LENGTH = 200;

export interface MarkdownImportPreview {
  previewId: string;
  sourceUrl: string;
  finalUrl: string;
  suggestedTitle: string;
  content: string;
}

interface PreviewSession extends PublicMarkdownResult {
  previewId: string;
  expiresAt: number;
  inFlight: boolean;
}

export interface MarkdownImportDeps {
  lib: Pick<PromptLibrary, "listPrompts" | "createPrompt">;
  fetchMarkdown?: typeof fetchPublicMarkdown;
  now?: () => number;
  createId?: () => string;
}

/**
 * A fetched Markdown document is an ephemeral, sender-bound preview. Its
 * content stays in the main process until the same window explicitly confirms.
 */
export class MarkdownImportService {
  private readonly sessionsBySender = new Map<number, PreviewSession>();
  private readonly generationBySender = new Map<number, number>();
  private readonly fetchMarkdown: typeof fetchPublicMarkdown;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: MarkdownImportDeps) {
    this.fetchMarkdown = deps.fetchMarkdown ?? fetchPublicMarkdown;
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
  }

  async preview(url: string, senderId: number): Promise<MarkdownImportPreview> {
    this.assertSenderId(senderId);
    const generation = this.invalidateSender(senderId);
    const fetched = await this.fetchMarkdown(url);
    if (this.generationBySender.get(senderId) !== generation) {
      throw new Error("This Markdown preview was replaced by a newer request.");
    }

    const existingTitles = this.deps.lib.listPrompts().map((prompt) => prompt.title);
    const session: PreviewSession = {
      ...fetched,
      previewId: this.createId(),
      suggestedTitle: boundedImportTitle(existingTitles, fetched.suggestedTitle),
      expiresAt: this.now() + PREVIEW_TTL_MS,
      inFlight: false,
    };
    this.sessionsBySender.set(senderId, session);
    return this.toPreview(session);
  }

  confirm(previewId: string, rawTitle: string, senderId: number): { promptId: string; title: string } {
    this.assertSenderId(senderId);
    const session = this.getSession(previewId, senderId);
    const title = rawTitle.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error("Prompt title must be between 1 and 200 characters.");
    }
    if (session.inFlight) throw new Error("This Markdown preview is already being imported.");

    session.inFlight = true;
    try {
      const prompt = this.deps.lib.createPrompt({
        title,
        content: session.content,
        changeNote: "Imported from Markdown URL",
        initialNote: [
          "Imported from Markdown URL",
          `Source: ${session.sourceUrl}`,
          `Final URL: ${session.finalUrl}`,
        ].join("\n"),
      });
      this.sessionsBySender.delete(senderId);
      return { promptId: prompt.id, title: prompt.title };
    } catch (error) {
      // A failed database transaction leaves the review actionable for retry.
      session.inFlight = false;
      throw error;
    }
  }

  discard(previewId: string, senderId: number): void {
    const session = this.sessionsBySender.get(senderId);
    if (session?.previewId === previewId) this.sessionsBySender.delete(senderId);
  }

  discardSender(senderId: number): void {
    this.invalidateSender(senderId);
  }

  private getSession(previewId: string, senderId: number): PreviewSession {
    const session = this.sessionsBySender.get(senderId);
    if (!session || session.previewId !== previewId) {
      throw new Error("This Markdown preview is invalid or has expired.");
    }
    if (session.expiresAt <= this.now()) {
      this.sessionsBySender.delete(senderId);
      throw new Error("This Markdown preview has expired. Fetch the URL again.");
    }
    return session;
  }

  private invalidateSender(senderId: number): number {
    const generation = (this.generationBySender.get(senderId) ?? 0) + 1;
    this.generationBySender.set(senderId, generation);
    this.sessionsBySender.delete(senderId);
    return generation;
  }

  private assertSenderId(senderId: number): void {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) {
      throw new Error("Markdown import requires a valid window sender.");
    }
  }

  private toPreview(session: PreviewSession): MarkdownImportPreview {
    return {
      previewId: session.previewId,
      sourceUrl: session.sourceUrl,
      finalUrl: session.finalUrl,
      suggestedTitle: session.suggestedTitle,
      content: session.content,
    };
  }
}

function boundedImportTitle(existingTitles: readonly string[], filenameTitle: string): string {
  const source = filenameTitle.trim().slice(0, MAX_TITLE_LENGTH) || "Imported prompt";
  for (let length = source.length; length > 0; length--) {
    const base = source.slice(0, length).trimEnd();
    if (!base) continue;
    const candidate = uniqueImportTitle(existingTitles, base);
    if (candidate.length <= MAX_TITLE_LENGTH) return candidate;
  }
  return uniqueImportTitle(existingTitles, "Imported prompt").slice(0, MAX_TITLE_LENGTH);
}

export interface AuthorizedFrameEvent {
  sender: { id: number };
  senderFrame: unknown;
}

export interface MainWindowFrameSource {
  webContents: { id: number; mainFrame: unknown };
}

/** Renderer IPC that can fetch or import must originate in this window's main frame. */
export function assertAuthorizedMainFrame(
  event: AuthorizedFrameEvent,
  mainWindow: MainWindowFrameSource | null,
): number {
  const mainFrame = mainWindow?.webContents.mainFrame;
  if (!mainWindow || !mainFrame || event.sender !== mainWindow.webContents) {
    throw new Error("Markdown import is only available to the main window.");
  }
  if (event.senderFrame !== mainFrame) {
    throw new Error("Markdown import is only available to the main frame.");
  }
  return event.sender.id;
}
