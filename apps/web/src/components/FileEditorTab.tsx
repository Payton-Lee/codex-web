import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileText, RefreshCw, Save } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";

type FileEditorTabProps = {
  path: string;
  name: string;
  preview?: boolean;
  onPromote?(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function extractFileText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (!isRecord(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  const dataBase64 = getString(payload, ["dataBase64", "contentBase64", "base64"]);
  if (dataBase64) {
    return base64ToText(dataBase64);
  }
  const text = getString(payload, ["text", "content", "data"]);
  if (text !== undefined) {
    return text;
  }
  return JSON.stringify(payload, null, 2);
}

function getFileExtension(pathValue: string): string {
  const name = pathValue.split(/[\\/]/).pop() ?? pathValue;
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : "";
}

function inferLanguage(pathValue: string): string {
  const fileName = (pathValue.split(/[\\/]/).pop() ?? pathValue).toLowerCase();
  if (fileName === "dockerfile") {
    return "dockerfile";
  }
  if (fileName === "makefile") {
    return "makefile";
  }
  const extension = getFileExtension(pathValue);
  const languages: Record<string, string> = {
    bat: "bat",
    c: "c",
    cc: "cpp",
    cmd: "bat",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    csv: "csv",
    cxx: "cpp",
    diff: "diff",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    html: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript",
    less: "less",
    log: "plaintext",
    lua: "lua",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "shell",
    sql: "sql",
    svg: "xml",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    vue: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml"
  };
  return languages[extension] ?? "plaintext";
}

export function FileEditorTab({ path, name, preview = false, onPromote }: FileEditorTabProps) {
  const [content, setContent] = useState("");
  const [metadata, setMetadata] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = inferLanguage(path);

  const loadFile = async () => {
    setLoading(true);
    setError(null);
    try {
      const [filePayload, metadataPayload] = await Promise.all([
        api.fsReadFile(path),
        api.fsMetadata(path).catch((metadataError) => ({
          metadataError: metadataError instanceof Error ? metadataError.message : String(metadataError)
        }))
      ]);
      setContent(extractFileText(filePayload));
      setMetadata(JSON.stringify(metadataPayload, null, 2));
      setDirty(false);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFile();
    // File path is the only reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const saveFile = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.fsWriteFile(path, textToBase64(content));
      setDirty(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <FileText size={16} className="text-blue-300" />
            <span className={cn("truncate", preview && "italic")}>{name}</span>
            {preview ? <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-text-secondary">Preview</span> : null}
            {dirty ? <span className="text-accent">*</span> : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-text-secondary" title={path}>
            {path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={loadFile}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            disabled={loading || saving}
          >
            <RefreshCw size={13} className={cn("inline", loading && "animate-spin")} />
            <span className="ml-1">Reload</span>
          </button>
          <button
            type="button"
            onClick={saveFile}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading || saving || !dirty}
          >
            <Save size={13} className="inline" />
            <span className="ml-1">{saving ? "Saving..." : "Save"}</span>
          </button>
        </div>
      </div>

      {error ? (
        <div className="m-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-h-0 overflow-hidden bg-[#1e1e1e]">
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={content}
            loading={<div className="p-5 text-sm text-text-secondary">Loading editor...</div>}
            options={{
              automaticLayout: true,
              fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
              fontSize: 14,
              lineHeight: 22,
              minimap: { enabled: false },
              renderLineHighlight: "all",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
              wordWrap: "on"
            }}
            onChange={(value) => {
              if (!dirty && preview) {
                onPromote?.();
              }
              setContent(value ?? "");
              setDirty(true);
            }}
            onMount={(editor) => {
              editor.focus();
            }}
          />
        </div>
        <aside className="hidden border-l border-border bg-sidebar/40 p-4 xl:block">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">Metadata</p>
          <pre className="max-h-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-[11px] leading-5 text-text-secondary">
            {metadata || "No metadata"}
          </pre>
        </aside>
      </div>
    </div>
  );
}
