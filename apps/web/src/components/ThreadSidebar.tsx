import { Circle, FolderClosed, Plus, RefreshCcw } from "lucide-react";
import type { ThreadSummary } from "../shared";
import { cn } from "../lib/utils";

interface Props {
  threads: ThreadSummary[];
  loadedThreadIds: string[];
  loadedRefreshedAt: number;
  selectedThreadId: string | null;
  onCreate(): void;
  onRefreshLatest(): void;
  onSelect(threadId: string): void;
  onRename(threadId: string): void;
  onArchive(threadId: string): void;
}

export function ThreadSidebar({
  threads,
  loadedThreadIds,
  loadedRefreshedAt,
  selectedThreadId,
  onCreate,
  onRefreshLatest,
  onSelect,
  onRename,
  onArchive
}: Props) {
  const loadedSet = new Set(loadedThreadIds);
  const lastSyncedLabel = loadedRefreshedAt
    ? new Date(loadedRefreshedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    : "未同步";

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between px-1">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Threads</h3>
            <p className="mt-1 text-[10px] text-text-secondary/70">
              最新 loaded 会话同步于 {lastSyncedLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded bg-white/5 p-1 text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
              onClick={onRefreshLatest}
              title="Sync Latest Threads"
              aria-label="Sync Latest Threads"
            >
              <RefreshCcw size={14} />
            </button>
            <button
              className="rounded bg-accent/20 p-1 text-accent transition-colors hover:bg-accent/30"
              onClick={onCreate}
              title="Create Thread"
              aria-label="Create Thread"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="space-y-1">
          {threads.length === 0 && <p className="px-3 text-xs italic text-text-secondary">暂无线程</p>}
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => onSelect(thread.id)}
              className={cn(
                "flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                selectedThreadId === thread.id
                  ? "border-accent/20 bg-accent/10"
                  : "border-transparent text-text-secondary hover:bg-white/5 hover:text-text-primary"
              )}
            >
              <div className="flex w-full items-center gap-2">
                <FolderClosed
                  size={14}
                  className={cn(selectedThreadId === thread.id ? "text-accent" : "text-text-secondary")}
                />
                <span
                  className={cn(
                    "flex-1 truncate text-[13px] font-medium",
                    selectedThreadId === thread.id && "text-text-primary"
                  )}
                >
                  {thread.preview || "空线程"}
                </span>
                {loadedSet.has(thread.id) && (
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                    loaded
                  </span>
                )}
                <span className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 font-mono text-[9px] uppercase text-text-secondary">
                  {thread.status}
                </span>
              </div>
              <div className="flex w-full items-center justify-between text-[10px]">
                <span className="flex-1 truncate font-mono opacity-70">{thread.cwd?.split("/").pop() || thread.cwd}</span>
                <div className="ml-2 flex items-center gap-1 uppercase opacity-70">
                  <Circle size={6} className="fill-current" />
                  {thread.source}
                </div>
              </div>
              {selectedThreadId === thread.id && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    className="rounded bg-white/5 px-2 py-1 text-[10px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRename(thread.id);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/20"
                    onClick={(event) => {
                      event.stopPropagation();
                      onArchive(thread.id);
                    }}
                  >
                    Archive
                  </button>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
