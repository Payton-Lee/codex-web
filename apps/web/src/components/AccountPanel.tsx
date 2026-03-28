import { BadgeCheck, LogOut, UserRound } from "lucide-react";
import type { AccountSummary } from "../shared";

interface Props {
  account: AccountSummary;
  onLogin(): void;
  onLogout(): void;
}

export function AccountPanel({ account, onLogin, onLogout }: Props) {
  return (
    <section>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <UserRound size={18} />
          </div>
          <div>
            <p className="shell-section-label">Account</p>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">官方 ChatGPT 登录</h2>
          </div>
        </div>
        <div
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            account.loggedIn ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-white/5 text-[var(--text-secondary)]"
          }`}
        >
          {account.loggedIn ? "已登录" : "未登录"}
        </div>
      </div>

      <div className="shell-card p-4">
        <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <BadgeCheck size={16} className="text-[var(--accent)]" />
          <span>{account.email ?? "未获取邮箱"}</span>
        </div>
        <div className="mt-4 grid gap-2 text-sm text-[var(--text-secondary)]">
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--accent)]">Account</p>
          <div>模式: {account.mode}</div>
          <div>套餐: {account.planType ?? "-"}</div>
          <div>
            主额度:
            {account.rateLimits?.primary?.used != null && account.rateLimits?.primary?.limit != null
              ? ` ${account.rateLimits.primary.used}/${account.rateLimits.primary.limit}`
              : " -"}
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-3">
        <button
          className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          onClick={onLogin}
        >
          使用 ChatGPT 登录
        </button>
        <button
          className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm text-[var(--text-primary)] transition hover:border-[var(--danger)] hover:text-[var(--danger)]"
          onClick={onLogout}
        >
          <LogOut size={14} />
          登出
        </button>
      </div>
    </section>
  );
}
