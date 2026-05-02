function trimTrailingSeparators(input: string): string {
  if (!input) {
    return input;
  }
  return input.replace(/[\\/]+$/, "") || input;
}

export function normalizeWorkspacePath(input: string): string {
  const withoutExtendedPrefix =
    typeof input === "string" && input.startsWith("\\\\?\\") ? input.slice(4) : input;
  const normalized = trimTrailingSeparators(withoutExtendedPrefix);
  return typeof window !== "undefined" && normalized.match(/^[a-zA-Z]:[\\/]/)
    ? normalized.toLowerCase()
    : normalized;
}

export function isThreadInWorkspace(threadCwd: string | null | undefined, workspacePath: string | null | undefined): boolean {
  if (!threadCwd || !workspacePath) {
    return false;
  }
  const normalizedThreadCwd = normalizeWorkspacePath(threadCwd);
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  return normalizedThreadCwd === normalizedWorkspacePath;
}
