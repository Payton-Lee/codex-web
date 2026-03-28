import { useMemo, useState } from "react";
import { FolderPlus } from "lucide-react";
import type { WorkspaceState } from "../shared";
import { cn } from "../lib/utils";

interface Props {
  workspace: WorkspaceState;
  allowedRoots: string[];
  onAdd(path: string): Promise<void> | void;
  onSelect(path: string): Promise<void> | void;
}

export function WorkspaceSelector({ workspace, allowedRoots, onAdd, onSelect }: Props) {
  const [input, setInput] = useState("");
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

  const submitAdd = async () => {
    const nextPath = input.trim();
    if (!nextPath) return;
    setPending(true);
    setError(null);
    try {
      await onAdd(nextPath);
      setInput("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-6">
      {/* 1. Add Workspace */}
      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">添加工作区</h3>
        <div className="flex gap-2 mb-2">
          <input
            id="workspace-path-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="/path/to/project"
            className="flex-1 bg-white/5 border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent text-text-primary min-w-0"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitAdd();
            }}
          />
          <button
            className="p-1.5 bg-accent/20 text-accent rounded hover:bg-accent/30 transition-colors disabled:opacity-50 shrink-0"
            disabled={pending || !input.trim()}
            onClick={() => void submitAdd()}
            title="添加"
          >
            <FolderPlus size={18} />
          </button>
        </div>
        {error ? (
          <div className="text-xs text-red-400 mt-1">{error}</div>
        ) : (
          <p className="text-[10px] text-text-secondary/60">
            白名单前缀: {effectiveRoots.length > 0 ? effectiveRoots.join(", ") : "未获取"}
          </p>
        )}
      </div>

      {/* 2. Workspace List */}
      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">工作区列表</h3>
        
        <div className="space-y-1">
          {sortedEntries.length === 0 ? (
            <p className="text-xs text-text-secondary italic px-3 mt-2">暂无工作区</p>
          ) : (
             sortedEntries.map((entry) => {
               const selected = entry.path === current;
               const label = entry.path.split(/[/\\]/).filter(Boolean).at(-1) || entry.path;
               return (
                 <button
                   key={entry.path}
                   onClick={() => void onSelect(entry.path)}
                   className={cn(
                     "w-full text-left px-3 py-2 rounded text-sm transition-colors flex flex-col gap-1",
                     selected 
                       ? "bg-accent/10 text-accent" 
                       : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                   )}
                 >
                   <div className="flex items-center gap-2">
                     <span className={cn("w-2 h-2 rounded-full shrink-0", selected ? "bg-accent" : "bg-white/20")} />
                     <span className="truncate font-medium">{label}</span>
                   </div>
                   <div className="truncate text-[10px] opacity-70 ml-4 font-mono">{entry.path}</div>
                 </button>
               );
             })
          )}
        </div>
      </div>
    </section>
  );
}
