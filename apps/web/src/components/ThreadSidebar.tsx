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
}

export function ThreadSidebar({
  threads,
  loadedThreadIds,
  loadedRefreshedAt,
  selectedThreadId,
  onCreate,
  onRefreshLatest,
  onSelect
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
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Threads</h3>
            <p className="mt-1 text-[10px] text-text-secondary/70">最新 loaded 会话同步于 {lastSyncedLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="p-1 bg-white/5 text-text-secondary rounded hover:bg-white/10 hover:text-text-primary transition-colors"
              onClick={onRefreshLatest}
              title="Sync Latest Threads"
              aria-label="Sync Latest Threads"
            >
              <RefreshCcw size={14} />
            </button>
            <button
              className="p-1 bg-accent/20 text-accent rounded hover:bg-accent/30 transition-colors"
              onClick={onCreate}
              title="Create Thread"
              aria-label="Create Thread"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        
        <div className="space-y-1">
          {threads.length === 0 && (
            <p className="text-xs text-text-secondary italic px-3">无线程</p>
          )}
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => onSelect(thread.id)}
              className={cn(
                "w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors flex flex-col gap-1.5",
                selectedThreadId === thread.id 
                  ? "bg-accent/10 border border-accent/20" 
                  : "text-text-secondary hover:bg-white/5 hover:text-text-primary border border-transparent"
              )}
            >
              <div className="flex items-center gap-2 w-full">
                <FolderClosed size={14} className={cn(selectedThreadId === thread.id ? "text-accent" : "text-text-secondary")} />
                <span className={cn("truncate font-medium flex-1 text-[13px]", selectedThreadId === thread.id && "text-text-primary")}>
                  {thread.preview || "空线程"}
                </span>
                {loadedSet.has(thread.id) && (
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                    loaded
                  </span>
                )}
                <span className="shrink-0 text-[9px] uppercase font-mono text-text-secondary bg-black/20 px-1.5 py-0.5 rounded">
                  {thread.status}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] w-full">
                 <span className="truncate opacity-70 flex-1 font-mono">
                   {thread.cwd?.split('/').pop() || thread.cwd}
                 </span>
                 <div className="flex items-center gap-1 uppercase opacity-70 ml-2">
                    <Circle size={6} className="fill-current" />
                    {thread.source}
                 </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
