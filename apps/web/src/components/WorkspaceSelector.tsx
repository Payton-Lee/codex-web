import { useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { WorkspaceState } from "../shared";
import { cn } from "../lib/utils";

interface Props {
  workspace: WorkspaceState;
  allowedRoots: string[];
  onPick(): Promise<void> | void;
  onSelect(path: string): Promise<void> | void;
}

export function WorkspaceSelector({ workspace, allowedRoots, onPick, onSelect }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = workspace.current ?? "";

  const effectiveRoots = useMemo(
    () => (allowedRoots.length > 0 ? allowedRoots : workspace.allowed.map((entry) => entry.path)),
    [allowedRoots, workspace.allowed]
  );

  const sortedEntries = useMemo(
    () =>
      [...workspace.allowed].sort((a, b) => {
        if (a.path === current) return -1;
        if (b.path === current) return 1;
        return a.path.localeCompare(b.path);
      }),
    [current, workspace.allowed]
  );

  const handlePick = async () => {
    setPending(true);
    setError(null);
    try {
      await onPick();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">打开工作区</h3>
        <button
          className="w-full flex items-center justify-center gap-2 rounded border border-border bg-white/5 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-white/10 disabled:opacity-50"
          disabled={pending}
          onClick={() => void handlePick()}
        >
          <FolderOpen size={16} />
          <span>{pending ? "正在打开文件夹选择器..." : "选择文件夹"}</span>
        </button>
        {error ? (
          <div className="mt-2 text-xs text-red-400">{error}</div>
        ) : (
          <p className="mt-2 text-[10px] text-text-secondary/60">
            允许范围: {effectiveRoots.length > 0 ? effectiveRoots.join(", ") : "未配置"}
          </p>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">工作区列表</h3>

        <div className="space-y-1">
          {sortedEntries.length === 0 ? (
            <p className="mt-2 px-3 text-xs italic text-text-secondary">暂无工作区</p>
          ) : (
            sortedEntries.map((entry) => {
              const selected = entry.path === current;
              const label = entry.path.split(/[/\\]/).filter(Boolean).at(-1) || entry.path;
              return (
                <button
                  key={entry.path}
                  onClick={() => void onSelect(entry.path)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded px-3 py-2 text-left text-sm transition-colors",
                    selected
                      ? "bg-accent/10 text-accent"
                      : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", selected ? "bg-accent" : "bg-white/20")} />
                    <span className="truncate font-medium">{label}</span>
                  </div>
                  <div className="ml-4 truncate font-mono text-[10px] opacity-70">{entry.path}</div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
