import { ExternalLink } from "lucide-react";
import { useToast } from "../lib/toast";

const RELEASES_URL = "https://github.com/PromptBranch/promptbranch/releases";

/** Settings → Updates: releases are downloaded and installed manually. */
export function UpdatesSection() {
  const { toast } = useToast();

  const openReleases = () => {
    void window.promptBuilder.app.openExternal(RELEASES_URL).catch(() => {
      toast("Could not open releases page");
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-line bg-app p-4">
        <p className="text-[12px] font-medium text-ink-dim">Updates are installed manually</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Open GitHub Releases, download the installer named for your operating system and CPU
          architecture, then install it over your current version. Your local library stays in place.
        </p>
      </div>
      <button
        type="button"
        onClick={openReleases}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
      >
        Open GitHub Releases
        <ExternalLink size={12} aria-hidden />
      </button>
    </div>
  );
}
