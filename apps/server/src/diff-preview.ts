import type { DiffPreview, FileChangeEntry } from "../../../packages/shared/src/index.js";

function stripPatchMeta(lines: string[]): string[] {
  return lines.filter((line) => !line.startsWith("@@") && !line.startsWith("---") && !line.startsWith("+++"));
}

export function buildDiffPreview(change: FileChangeEntry): DiffPreview {
  if (!change.diff || change.diff.includes("Binary files")) {
    return {
      path: change.path,
      kind: change.kind,
      original: "",
      modified: "",
      isBinary: true,
      rawDiff: change.diff
    };
  }

  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  for (const line of stripPatchMeta(change.diff.split("\n"))) {
    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    }
  }

  return {
    path: change.path,
    kind: change.kind,
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
    isBinary: false,
    rawDiff: change.diff
  };
}

