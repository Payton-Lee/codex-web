import { useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, ShieldCheck, XCircle } from "lucide-react";
import type { ApprovalDecision, ApprovalRequest } from "../shared";

interface Props {
  approvals: ApprovalRequest[];
  history: ApprovalRequest[];
  onResolve(id: string, payload: { decision: ApprovalDecision; answers?: Record<string, string> }): void;
}

function kindLabel(kind: ApprovalRequest["kind"]): string {
  if (kind === "command") return "命令执行";
  if (kind === "fileChange") return "文件修改";
  if (kind === "dynamicTool") return "工具调用";
  return "用户输入";
}

function decisionLabel(decision: ApprovalDecision | null | undefined): string {
  if (decision === "accept") return "已允许";
  if (decision === "acceptForSession") return "本会话允许";
  if (decision === "decline") return "已拒绝";
  if (decision === "cancel") return "已取消";
  return "已处理";
}

export function ApprovalDrawer({ approvals, history, onResolve }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const current = approvals[0];
  const recentHistory = useMemo(() => history.slice(0, 8), [history]);

  if (!current && recentHistory.length === 0) {
    return (
      <section className="space-y-4">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-text-secondary font-semibold">Approvals</p>
          <h2 className="mt-1 text-sm font-semibold text-text-primary">审批中心</h2>
        </div>
        <div className="rounded-xl border border-border bg-white/5 p-8 flex flex-col items-center justify-center text-center opacity-60">
           <ShieldCheck size={36} className="text-text-secondary/30 mb-3" />
           <p className="text-sm text-text-secondary">当前没有待处理审批。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-text-secondary font-semibold">Approvals</p>
          <h2 className="mt-1 text-sm font-semibold text-text-primary">审批中心</h2>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-bold">
          <span className="rounded-full bg-red-500/15 px-3 py-1 text-red-500">{approvals.length} pending</span>
          <span className="rounded-full bg-white/5 px-3 py-1 text-text-secondary">{recentHistory.length} history</span>
        </div>
      </div>

      {current ? (
        <>
          <div className="rounded-xl border border-border bg-black/20 p-4 text-sm text-text-secondary shadow-inner">
            <div className="flex items-center gap-2 text-text-primary mb-3">
              <CircleAlert size={16} className="text-accent" />
              <span className="font-semibold text-[13px]">类型: {kindLabel(current.kind)}</span>
            </div>
            <div className="mb-3 text-[13px] bg-red-500/10 text-red-400 p-2 border-l-2 border-red-500 rounded-r-md">
              风险提示: {current.riskHint}
            </div>

            {current.command && (
              <div className="mt-2 text-xs bg-black/40 border border-white/5 p-2 rounded-lg text-text-primary font-mono whitespace-pre-wrap">
                {current.command}
              </div>
            )}
            {current.cwd && <div className="mt-3 font-mono text-[11px] text-text-secondary">cwd: {current.cwd}</div>}
            {current.grantRoot && (
              <div className="mt-1 font-mono text-[11px] text-text-secondary">target: {current.grantRoot}</div>
            )}

            {current.questions && current.questions.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                {current.questions.map((question) => (
                  <div key={question.id} className="mb-4 last:mb-0">
                    <label
                      className="mb-1.5 block text-[10px] uppercase tracking-wider text-accent font-semibold"
                      htmlFor={`approval-answer-${question.id}`}
                    >
                      {question.header}
                    </label>
                    <div className="mb-2 text-sm text-text-primary">{question.question}</div>
                    <input
                      id={`approval-answer-${question.id}`}
                      name={`approval-answer-${question.id}`}
                      className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors"
                      value={answers[question.id] ?? ""}
                      onChange={(event) =>
                        setAnswers((state) => ({
                          ...state,
                          [question.id]: event.target.value
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button
              className="w-full flex justify-center items-center gap-2 rounded-lg bg-green-500/20 text-green-500 hover:bg-green-500/30 border border-green-500/20 px-4 py-2 text-sm font-semibold transition-colors"
              onClick={() =>
                onResolve(current.id, {
                  decision: "accept",
                  answers: current.kind === "userInput" ? answers : undefined
                })
              }
            >
              <ShieldCheck size={16} />
              允许
            </button>
            <button
              className="w-full flex justify-center items-center gap-2 rounded-lg bg-white/5 text-text-primary hover:bg-white/10 border border-border px-4 py-2.5 text-sm transition-colors"
              onClick={() =>
                onResolve(current.id, {
                  decision: "acceptForSession",
                  answers: current.kind === "userInput" ? answers : undefined
                })
              }
            >
              允许本会话
            </button>
            <button
              className="w-full flex justify-center items-center gap-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 px-4 py-2.5 text-sm transition-colors mt-2"
              onClick={() => onResolve(current.id, { decision: "decline" })}
            >
              <XCircle size={16} />
              拒绝
            </button>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-border bg-white/5 p-6 text-center text-sm text-text-secondary">
          当前没有待处理审批，请查看下方最近处理记录。
        </div>
      )}

      <div className="space-y-2">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-text-secondary font-semibold">History</p>
          <h3 className="mt-1 text-sm font-semibold text-text-primary">最近处理记录</h3>
        </div>
        {recentHistory.length === 0 ? (
          <div className="rounded-xl border border-border bg-white/5 p-4 text-sm text-text-secondary">
            还没有已处理的审批记录。
          </div>
        ) : (
          recentHistory.map((entry) => (
            <div key={entry.id} className="rounded-xl border border-border bg-white/5 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-text-primary">
                  <CheckCircle2 size={14} className="text-emerald-400" />
                  <span className="font-medium">{kindLabel(entry.kind)}</span>
                </div>
                <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] uppercase text-text-secondary">
                  {decisionLabel(entry.resolutionDecision)}
                </span>
              </div>
              {entry.command ? (
                <div className="mt-2 font-mono text-[11px] text-text-secondary break-all">{entry.command}</div>
              ) : null}
              {entry.cwd ? <div className="mt-1 font-mono text-[11px] text-text-secondary">cwd: {entry.cwd}</div> : null}
              <div className="mt-2 text-[11px] text-text-secondary">
                {entry.resolvedAt ? new Date(entry.resolvedAt).toLocaleString("zh-CN") : "刚刚处理"}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
