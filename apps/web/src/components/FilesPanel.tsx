import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  Info,
  Plus,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
  raw: unknown;
};

type FilesPanelProps = {
  rootPath: string | null;
  onOpenFile?(file: { path: string; name: string }, mode?: "preview" | "pinned"): void;
};

const DIRECTORY_KEYS = ["entries", "items", "files", "children", "directories"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function getBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function getNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getPathName(pathValue: string): string {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function getPathSeparator(basePath: string): "\\" | "/" {
  return basePath.includes("\\") ? "\\" : "/";
}

function joinPath(basePath: string, name: string): string {
  const separator = getPathSeparator(basePath);
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${name.replace(/^[\\/]+/, "")}`;
}

function extractDirectoryArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return [];
  }
  for (const key of DIRECTORY_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function normalizeEntries(payload: unknown, currentPath: string): FileEntry[] {
  return extractDirectoryArray(payload)
    .map((entry): FileEntry | null => {
      if (typeof entry === "string") {
        return {
          name: getPathName(entry),
          path: entry,
          isDirectory: false,
          raw: entry
        };
      }
      if (!isRecord(entry)) {
        return null;
      }
      const pathValue = getString(entry, ["path", "fullPath", "absolutePath"]) ?? "";
      const name = getString(entry, ["name", "fileName", "basename"]) ?? (pathValue ? getPathName(pathValue) : "");
      if (!name && !pathValue) {
        return null;
      }
      const type = getString(entry, ["type", "kind", "fileType"])?.toLowerCase() ?? "";
      const typeLooksLikeDirectory = type === "directory" || type === "folder" || type === "dir";
      const isDirectory = getBoolean(entry, ["isDirectory", "directory", "isDir"]) ?? typeLooksLikeDirectory;
      return {
        name: name || getPathName(pathValue),
        path: pathValue || joinPath(currentPath, name),
        isDirectory,
        size: getNumber(entry, ["size", "bytes", "byteLength"]),
        modifiedAt: getString(entry, ["modifiedAt", "mtime", "updatedAt"]),
        raw: entry
      };
    })
    .filter((entry): entry is FileEntry => Boolean(entry))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

function formatSize(size?: number): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function toMetadataText(metadata: unknown): string {
  return JSON.stringify(metadata, null, 2);
}

export function FilesPanel({ rootPath, onOpenFile }: FilesPanelProps) {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [activeDirectory, setActiveDirectory] = useState(rootPath ?? "");
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [metadataText, setMetadataText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);
  const watchIdRef = useRef<string | null>(null);

  const rootEntry = useMemo<FileEntry | null>(
    () =>
      rootPath
        ? {
            name: getPathName(rootPath),
            path: rootPath,
            isDirectory: true,
            raw: { path: rootPath, type: "directory" }
          }
        : null,
    [rootPath]
  );

  const isLoading = loadingPaths.size > 0;
  const activePathLabel = activeDirectory || rootPath || "";

  useEffect(() => {
    setChildrenByPath({});
    setExpandedPaths(rootPath ? new Set([rootPath]) : new Set());
    setSelectedEntry(null);
    setActiveDirectory(rootPath ?? "");
    setMetadataText("");
    setError(null);
    setWatchId(null);
  }, [rootPath]);

  const loadDirectory = async (pathValue: string) => {
    if (!pathValue) {
      return;
    }
    setLoadingPaths((paths) => new Set(paths).add(pathValue));
    setError(null);
    try {
      const payload = await api.fsReadDirectory(pathValue);
      setChildrenByPath((children) => ({
        ...children,
        [pathValue]: normalizeEntries(payload, pathValue)
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingPaths((paths) => {
        const next = new Set(paths);
        next.delete(pathValue);
        return next;
      });
    }
  };

  useEffect(() => {
    if (rootPath) {
      void loadDirectory(rootPath);
    }
    // Root path changes are the only automatic load trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const refreshDirectory = async (pathValue = activeDirectory || rootPath || "") => {
    if (pathValue) {
      await loadDirectory(pathValue);
    }
  };

  const toggleDirectory = async (entry: FileEntry) => {
    setSelectedEntry(entry);
    setActiveDirectory(entry.path);
    setMetadataText("");
    const isExpanded = expandedPaths.has(entry.path);
    setExpandedPaths((paths) => {
      const next = new Set(paths);
      if (isExpanded) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      return next;
    });
    if (!isExpanded && !childrenByPath[entry.path]) {
      await loadDirectory(entry.path);
    }
  };

  const openFile = async (entry: FileEntry, mode: "preview" | "pinned" = "preview") => {
    setSelectedEntry(entry);
    onOpenFile?.({ path: entry.path, name: entry.name }, mode);
    setError(null);
    setMetadataText("");
    try {
      const metadataPayload = await api.fsMetadata(entry.path).catch((metadataError) => ({
        metadataError: metadataError instanceof Error ? metadataError.message : String(metadataError)
      }));
      setMetadataText(toMetadataText(metadataPayload));
    } catch (metadataError) {
      setError(metadataError instanceof Error ? metadataError.message : String(metadataError));
    }
  };

  const createFile = async () => {
    const directory = activeDirectory || rootPath;
    if (!directory) {
      return;
    }
    const name = window.prompt("New file name");
    if (!name?.trim()) {
      return;
    }
    setError(null);
    try {
      await api.fsWriteFile(joinPath(directory, name.trim()), "");
      await loadDirectory(directory);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const createDirectory = async () => {
    const directory = activeDirectory || rootPath;
    if (!directory) {
      return;
    }
    const name = window.prompt("New folder name");
    if (!name?.trim()) {
      return;
    }
    setError(null);
    try {
      await api.fsCreateDirectory(joinPath(directory, name.trim()), true);
      await loadDirectory(directory);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const deleteSelected = async () => {
    if (!selectedEntry) {
      return;
    }
    const ok = window.confirm(`Delete ${selectedEntry.name}?`);
    if (!ok) {
      return;
    }
    setError(null);
    try {
      await api.fsRemove(selectedEntry.path, selectedEntry.isDirectory, true);
      setSelectedEntry(null);
      setMetadataText("");
      await refreshDirectory();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };

  const copySelected = async () => {
    if (!selectedEntry) {
      return;
    }
    const destination = window.prompt("Copy destination path", `${selectedEntry.path}.copy`);
    if (!destination?.trim()) {
      return;
    }
    setError(null);
    try {
      await api.fsCopy(selectedEntry.path, destination.trim(), selectedEntry.isDirectory);
      await refreshDirectory();
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const refreshMetadata = async () => {
    if (!selectedEntry) {
      return;
    }
    setError(null);
    try {
      setMetadataText(toMetadataText(await api.fsMetadata(selectedEntry.path)));
    } catch (metadataError) {
      setError(metadataError instanceof Error ? metadataError.message : String(metadataError));
    }
  };

  const toggleWatch = async () => {
    const directory = activeDirectory || rootPath;
    if (!directory) {
      return;
    }
    setError(null);
    try {
      if (watchId) {
        await api.fsUnwatch(watchId);
        setWatchId(null);
        return;
      }
      const nextWatchId = `files-panel-${Date.now()}`;
      await api.fsWatch(directory, nextWatchId);
      setWatchId(nextWatchId);
    } catch (watchError) {
      setError(watchError instanceof Error ? watchError.message : String(watchError));
    }
  };

  useEffect(() => {
    watchIdRef.current = watchId;
  }, [watchId]);

  useEffect(
    () => () => {
      if (watchIdRef.current) {
        void api.fsUnwatch(watchIdRef.current).catch(() => undefined);
      }
    },
    []
  );

  const renderTreeNode = (entry: FileEntry, depth: number) => {
    const expanded = expandedPaths.has(entry.path);
    const children = childrenByPath[entry.path] ?? [];
    const loading = loadingPaths.has(entry.path);
    const selected = selectedEntry?.path === entry.path;

    return (
      <div key={entry.path}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => (entry.isDirectory ? void toggleDirectory(entry) : void openFile(entry, "preview"))}
          onDoubleClick={() => {
            if (!entry.isDirectory) {
              void openFile(entry, "pinned");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (entry.isDirectory) {
                void toggleDirectory(entry);
              } else {
                void openFile(entry, "pinned");
              }
            }
          }}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left outline-none hover:bg-white/5",
            selected && "bg-accent/10 text-accent"
          )}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.path}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-secondary">
            {entry.isDirectory ? (
              expanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : null}
          </span>
          {entry.isDirectory ? (
            <Folder size={15} className="shrink-0 text-amber-300" />
          ) : (
            <FileText size={15} className="shrink-0 text-blue-300" />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px]">{entry.name}</span>
          {loading ? (
            <RefreshCw size={11} className="shrink-0 animate-spin text-text-secondary" />
          ) : (
            !entry.isDirectory &&
            entry.size !== undefined && (
              <span className="shrink-0 text-[10px] text-text-secondary opacity-0 group-hover:opacity-100">
                {formatSize(entry.size)}
              </span>
            )
          )}
        </div>
        {entry.isDirectory && expanded && (
          <div>
            {children.length > 0 ? (
              children.map((child) => renderTreeNode(child, depth + 1))
            ) : (
              <div className="py-1 pr-2 text-[10px] text-text-secondary" style={{ paddingLeft: 34 + depth * 14 }}>
                {loading ? "Loading..." : "Empty"}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!rootEntry) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center text-text-secondary">
        <Folder size={40} className="mb-3 opacity-40" />
        <p className="text-sm text-text-primary">Select a workspace first</p>
        <p className="mt-1 text-[11px] leading-5 opacity-70">Files are loaded from the active workspace.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">Files</p>
            <p className="mt-1 truncate text-[11px] text-text-secondary" title={activePathLabel}>
              {activePathLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshDirectory()}
            className="rounded-lg border border-border/70 p-1.5 text-text-secondary hover:border-accent/60 hover:text-accent"
            title="Refresh"
          >
            <RefreshCw size={14} className={cn(isLoading && "animate-spin")} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={createFile}
            className="rounded-md border border-border/60 px-2 py-1.5 text-text-secondary hover:text-text-primary"
            title="New file"
          >
            <Plus size={14} className="mx-auto" />
          </button>
          <button
            type="button"
            onClick={createDirectory}
            className="rounded-md border border-border/60 px-2 py-1.5 text-text-secondary hover:text-text-primary"
            title="New folder"
          >
            <FolderPlus size={14} className="mx-auto" />
          </button>
          <button
            type="button"
            onClick={toggleWatch}
            className={cn(
              "rounded-md border border-border/60 px-2 py-1.5 text-text-secondary hover:text-text-primary",
              watchId && "border-accent/70 text-accent"
            )}
            title={watchId ? "Stop watching" : "Watch active folder"}
          >
            {watchId ? <EyeOff size={14} className="mx-auto" /> : <Eye size={14} className="mx-auto" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] leading-5 text-red-200">
          {error}
        </div>
      )}

      <div className="min-h-[180px] flex-1 overflow-auto rounded-xl border border-border/70 bg-panel/40 p-1">
        {renderTreeNode(rootEntry, 0)}
      </div>

      {selectedEntry && (
        <div className="space-y-2 rounded-xl border border-border/70 bg-bg/70 p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-text-primary" title={selectedEntry.path}>
                {selectedEntry.name}
              </p>
              <p className="mt-0.5 text-[10px] text-text-secondary">
                {selectedEntry.isDirectory ? "Folder" : formatSize(selectedEntry.size) || "File"}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={refreshMetadata}
                className="rounded border border-border/60 p-1 text-text-secondary hover:text-text-primary"
                title="Metadata"
              >
                <Info size={13} />
              </button>
              <button
                type="button"
                onClick={copySelected}
                className="rounded border border-border/60 p-1 text-text-secondary hover:text-text-primary"
                title="Copy"
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                onClick={deleteSelected}
                className="rounded border border-border/60 p-1 text-red-300 hover:border-red-400/50"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {metadataText && (
            <pre className="max-h-32 overflow-auto rounded-lg bg-black/30 p-2 text-[10px] leading-4 text-text-secondary">
              {metadataText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
