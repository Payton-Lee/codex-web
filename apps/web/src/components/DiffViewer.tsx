import { useEffect, useState } from "react";
import { FileCode, GitCompareArrows } from "lucide-react";
import type { DiffPreview } from "../shared";
import { api } from "../api";
import { cn } from "../lib/utils";

interface Props {
  threadId: string | null;
  turnId: string | null;
}

export function DiffViewer({ threadId, turnId }: Props) {
  const [previews, setPreviews] = useState<DiffPreview[]>([]);
  const [rawDiff, setRawDiff] = useState("");
  const [selectedPreviewKey, setSelectedPreviewKey] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId || !turnId) {
      setPreviews([]);
      setRawDiff("");
      setSelectedPreviewKey(null);
      return;
    }
    api.diff(threadId, turnId).then((result) => {
      setPreviews(result.previews);
      setRawDiff(result.diff);
      setSelectedPreviewKey(result.previews[0] ? `${result.previews[0].path}::0` : null);
    });
  }, [threadId, turnId]);

  const previewEntries = previews.map((preview, index) => ({
    key: `${preview.path}::${index}`,
    preview
  }));

  const current =
    previewEntries.find((entry) => entry.key === selectedPreviewKey)?.preview ??
    previewEntries[0]?.preview ??
    null;
  const fallbackDiff = current?.rawDiff || rawDiff || "暂无 diff";

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <GitCompareArrows size={18} />
          </div>
          <div>
            <p className="text-[10px] tracking-widest uppercase text-text-secondary font-semibold">Diff</p>
            <h2 className="mt-1 text-sm font-semibold text-text-primary">文件变更预览</h2>
          </div>
        </div>
      </div>

      {previews.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2">
            {previewEntries.map((entry, index) => (
              <button
                key={entry.key}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors",
                  entry.key === selectedPreviewKey || (!selectedPreviewKey && index === 0)
                    ? "bg-accent/20 text-accent border border-accent/30" 
                    : "bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary border border-transparent"
                )}
                onClick={() => setSelectedPreviewKey(entry.key)}
              >
                <FileCode size={12} />
                {entry.preview.path}
              </button>
            ))}
          </div>
          {current?.isBinary ? (
            <div className="rounded-xl border border-border bg-white/5 p-4 text-sm text-text-secondary">
              二进制或非文本变更，当前仅展示原始 diff。
              <pre className="mt-3 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-primary p-3 bg-black/20 rounded-lg">
                {current.rawDiff}
              </pre>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-black/10">
              <div className="grid gap-px bg-border lg:grid-cols-2">
                <section className="min-w-0 bg-[rgba(19,27,44,0.92)]">
                  <div className="border-b border-border/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                    Before
                  </div>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-text-secondary">
                    {current?.original ?? ""}
                  </pre>
                </section>
                <section className="min-w-0 bg-[rgba(9,34,26,0.92)]">
                  <div className="border-b border-border/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                    After
                  </div>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-emerald-100">
                    {current?.modified ?? ""}
                  </pre>
                </section>
              </div>
              <details className="border-t border-border bg-black/20">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                  Raw Patch
                </summary>
                <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words border-t border-border/80 p-4 font-mono text-xs leading-6 text-text-primary">
                  {fallbackDiff}
                </pre>
              </details>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-border bg-white/5 p-8 flex flex-col items-center justify-center text-center">
          <FileCode size={36} className="text-text-secondary/30 mb-3" />
          <p className="text-sm text-text-secondary">当前回合尚无结构化文件 diff。</p>
          <pre className="mt-4 max-h-[260px] w-full overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-black/20 p-4 text-left font-mono text-xs leading-6 text-text-primary">
            {fallbackDiff}
          </pre>
        </div>
      )}
    </section>
  );
}
