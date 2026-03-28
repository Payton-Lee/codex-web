function trimTrailingSeparators(input: string): string {
  if (!input) {
    return input;
  }
  return input.replace(/[\\/]+$/, "") || input;
}

export function normalizeWorkspacePath(input: string): string {
  return trimTrailingSeparators(input);
}

export function isThreadInWorkspace(threadCwd: string | null | undefined, workspacePath: string | null | undefined): boolean {
  if (!threadCwd || !workspacePath) {
    return false;
  }
  const normalizedThreadCwd = normalizeWorkspacePath(threadCwd);
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  return normalizedThreadCwd === normalizedWorkspacePath;
}
