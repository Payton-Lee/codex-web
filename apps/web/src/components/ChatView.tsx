import { useMemo, useState, useRef, useEffect } from "react";
import { Bot, FileCode, Send, Sparkles, Terminal, ChevronDown, ChevronUp, ArrowDown, User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { AppServerCatalog, SkillSuggestion, ThreadDetail, ThreadItem, WorkspaceFileSuggestion } from "../shared";
import { cn } from "../lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api } from "../api";
import {
  commandSuggestions,
  findActiveComposerToken,
  isMcpPrompt,
  replaceComposerToken,
  type SlashCommandId,
  type ActiveComposerToken,
  type ComposerSuggestion
} from "../lib/composer";

type ThreadTurn = ThreadDetail["turns"][0];

interface Props {
  detail: ThreadDetail | null;
  liveDeltas: Record<string, { stream: string; text: string; threadId: string; turnId: string; item: ThreadItem }>;
  pendingPrompt?: string | null;
  detailRefreshing?: boolean;
  onSend(prompt: string): Promise<void> | void;
  onInterrupt(): void;
  onSlashCommand?(command: SlashCommandId): void;
  language: "zh" | "en";
  workspaceName?: string;
  canSend?: boolean;
  appServerCatalog?: AppServerCatalog | null;
}

function itemDisplayText(item: ThreadTurn["items"][number]): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  const content = Array.isArray(item.content) ? (item.content as unknown as Array<Record<string, unknown>>) : null;
  if (!content) {
    return "";
  }
  return content
    .map((entry) =>
      typeof entry.text === "string" ? entry.text : ""
    )
    .join("")
    .trim();
}

function displayChangeKind(kind: unknown): string {
  if (typeof kind === "string") {
    return kind;
  }
  if (!kind || typeof kind !== "object") {
    return "unknown";
  }
  const candidate = kind as { type?: unknown; move_path?: unknown };
  const type = typeof candidate.type === "string" ? candidate.type : "unknown";
  const movePath = typeof candidate.move_path === "string" && candidate.move_path.length > 0
    ? ` -> ${candidate.move_path}`
    : "";
  return `${type}${movePath}`;
}

const GlobalMarkdownComponents: Components = {
  h1: ({ ref, ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4 text-text-primary" {...props} />,
  h2: ({ ref, ...props }) => <h2 className="text-xl font-bold mt-6 mb-3 text-text-primary border-b border-border pb-2" {...props} />,
  h3: ({ ref, ...props }) => <h3 className="text-lg font-bold mt-5 mb-3 text-text-primary" {...props} />,
  h4: ({ ref, ...props }) => <h4 className="text-base font-bold mt-4 mb-2 text-text-primary" {...props} />,
  p: ({ ref, ...props }) => <p className="mb-4 leading-relaxed text-text-primary/90" {...props} />,
  ul: ({ ref, ...props }) => <ul className="mb-4 pl-6 list-disc space-y-1 text-text-primary/90" {...props} />,
  ol: ({ ref, ...props }) => <ol className="mb-4 pl-6 list-decimal space-y-1 text-text-primary/90" {...props} />,
  li: ({ ref, ...props }) => <li className="leading-relaxed" {...props} />,
  a: ({ ref, ...props }) => <a className="text-accent hover:underline font-medium" {...props} />,
  strong: ({ ref, ...props }) => <strong className="font-semibold text-text-primary" {...props} />,
  blockquote: ({ ref, ...props }) => <blockquote className="border-l-4 border-accent/50 pl-4 py-1 my-4 bg-accent/5 rounded-r text-text-primary" {...props} />,
  code({ node, inline, className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : '';
    return !inline && match ? (
      <div className="rounded-lg overflow-hidden my-4 border border-border">
        <div className="flex items-center justify-between px-4 py-1.5 bg-black/40 text-xs text-text-secondary select-none font-mono uppercase tracking-wider">
           <span>{language}</span>
        </div>
        <SyntaxHighlighter
          {...props}
          PreTag="div"
          children={String(children).replace(/\n$/, '')}
          language={language}
          style={vscDarkPlus}
          customStyle={{ margin: 0, padding: '1rem', background: 'var(--chat-bg)', fontSize: '0.85rem', lineHeight: '1.5' }}
        />
      </div>
    ) : (
      <code className="bg-white/10 text-accent px-1.5 py-0.5 rounded-md text-sm font-mono" {...props}>
        {children}
      </code>
    );
  }
};

function TurnItem({ turn, isLatest }: { turn: ThreadTurn; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(isLatest || turn.status === "inProgress");

  const hasAIOrCommandItems = turn.items.some((i) => i.type !== "userMessage");

  // Determine summary to display when collapsed
  let summaryText = "助手工作中，点击展开日志...";
  if (hasAIOrCommandItems) {
     const agentItem = turn.items.find(i => i.type === "agentMessage" && typeof i.text === "string" && i.text);
     if (agentItem?.text) {
        summaryText = agentItem.text.replace(/\n|#/g, " ").substring(0, 80);
        if (agentItem.text.length > 80) summaryText += "...";
     } else {
        const cmdItem = turn.items.find(i => i.type === "commandExecution" || i.type === "fileChange");
        if (cmdItem) summaryText = `处理了相关代码变更指令 ${cmdItem.command || ""}`.substring(0,80);
     }
  }

  return (
    <div className="flex flex-col w-full mb-8 relative px-6">
      {/* 永远渲染 UserMessage 置顶展示不可折叠 */}
      {turn.items.map((item) => {
        const userText = itemDisplayText(item);
        if (item.type === "userMessage" && userText) {
          return (
            <div key={item.id} className="w-full p-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary shadow-sm text-left mb-4">
              <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary font-semibold">
                <User size={14} /> YOU
              </div>
              <pre className="whitespace-pre-wrap font-sans text-[15px] text-text-primary/90">{userText}</pre>
            </div>
          );
        }
        return null;
      })}
      
      {/* 剩余的非用户指令，折叠展示或者完全展开逻辑 */}
      {hasAIOrCommandItems && (
         expanded ? (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4 mt-2">
               {turn.items.map(item => {
                  if (item.type === "userMessage") return null;

                  return (
                    <div key={item.id} className="relative group w-full p-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary shadow-sm text-left">
                       {/* 内部折叠悬浮按钮 */}
                       {!isLatest && (
                          <button 
                            onClick={() => setExpanded(false)} 
                            className="absolute top-3 right-3 p-1.5 bg-white/5 hover:bg-white/10 rounded-md text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity" 
                            title="折叠卡片"
                          >
                             <ChevronUp size={14} />
                          </button>
                       )}

                       <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent font-semibold pr-8">
                         {item.type === "agentMessage" ? <Bot size={14} /> : null}
                         {item.type === "commandExecution" ? <Terminal size={14} /> : null}
                         {item.type === "fileChange" ? <FileCode size={14} /> : null}
                         {item.type}
                         {item.status ? <span className="text-text-secondary">({item.status})</span> : null}
                       </div>

                       {itemDisplayText(item) ? (
                          item.type === "agentMessage" ? (
                            <div className="max-w-none text-text-primary overflow-hidden break-words">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={GlobalMarkdownComponents}>
                                {itemDisplayText(item)}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <pre className="whitespace-pre-wrap text-sm font-sans break-words">{itemDisplayText(item)}</pre>
                          )
                       ) : null}
                       {item.command ? <pre className="mb-2 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-primary bg-black/30 p-2 rounded-lg">{item.command}</pre> : null}
                       {item.aggregatedOutput ? <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] text-text-secondary bg-black/20 p-2 rounded-lg">{item.aggregatedOutput}</pre> : null}
                       {item.changes?.length ? (
                         <div className="space-y-1 mt-2">
                           {item.changes.map((change) => (
                             <div key={change.path} className="rounded border border-border bg-white/5 px-2 py-1 font-mono text-xs text-text-secondary flex gap-2">
                               <span className="text-accent">{displayChangeKind(change.kind)}:</span>
                               <span className="truncate">{change.path}</span>
                             </div>
                           ))}
                         </div>
                       ) : null}
                    </div>
                  )
               })}
            </motion.div>
         ) : (
            <button 
              onClick={() => setExpanded(true)}
              className="w-full text-left p-3 mt-1 rounded-xl border border-border/50 bg-black/20 text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors flex items-center gap-3 group shadow-sm"
            >
              <div className="flex-1 min-w-0">
                 <p className="text-xs font-medium truncate opacity-70 flex items-center gap-1.5">
                   <Bot size={13} className="shrink-0 text-accent/80" />
                   <span className="truncate">{summaryText}</span>
                 </p>
              </div>
              <ChevronDown size={14} className="opacity-50 group-hover:opacity-100 shrink-0" />
            </button>
         )
      )}
    </div>
  );
}

function LiveItemCard({ item, stream, text }: { item: ThreadItem; stream: string; text: string }) {
  const displayText = text || itemDisplayText(item as ThreadTurn["items"][number]);

  return (
    <div className="w-full p-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary text-left shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent font-semibold">
        {item.type === "agentMessage" ? <Bot size={14} /> : null}
        {item.type === "commandExecution" ? <Terminal size={14} /> : null}
        {item.type === "fileChange" ? <FileCode size={14} /> : null}
        <span>{item.type}</span>
        {item.status ? <span className="text-text-secondary">({item.status})</span> : null}
        <span className="ml-auto text-text-secondary">{stream}</span>
      </div>
      {item.command ? <pre className="mb-2 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-primary bg-black/30 p-2 rounded-lg">{item.command}</pre> : null}
      {displayText ? (
        item.type === "agentMessage" || item.type === "reasoning" ? (
          <div className="max-w-none text-text-primary overflow-hidden break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={GlobalMarkdownComponents}>
              {displayText}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-sm font-sans break-words">{displayText}</pre>
        )
      ) : null}
      {item.aggregatedOutput && item.aggregatedOutput !== displayText ? (
        <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-text-secondary bg-black/20 p-2 rounded-lg">{item.aggregatedOutput}</pre>
      ) : null}
      {item.changes?.length ? (
        <div className="space-y-1 mt-2">
          {item.changes.map((change) => (
            <div key={change.path} className="rounded border border-border bg-white/5 px-2 py-1 font-mono text-xs text-text-secondary flex gap-2">
              <span className="text-accent">{displayChangeKind(change.kind)}:</span>
              <span className="truncate">{change.path}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatView({
  detail,
  liveDeltas,
  pendingPrompt,
  detailRefreshing = false,
  onSend,
  onInterrupt,
  onSlashCommand,
  language,
  canSend = true,
  appServerCatalog
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [activeToken, setActiveToken] = useState<ActiveComposerToken | null>(null);
  const [suggestions, setSuggestions] = useState<ComposerSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const submitPrompt = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) {
      return;
    }
    await onSend(nextPrompt);
    setPrompt("");
  };

  const handleSubmitPrompt = async () => {
    try {
      await submitPrompt();
    } catch {
      // Errors are surfaced through global store error state; keep the draft intact here.
    }
  };

  const t =
    language === "zh"
      ? {
          label: "Chat",
          current: "当前线程",
          description: "聊天流式输出、命令执行、文件修改均在此展示。",
          emptyTitle: "今天我能帮你写点什么代码？",
          emptyText: canSend
            ? "请选择的线程正在加载，或当前线程还没有消息。"
            : "请先在左侧选择一个线程，或手动创建新线程后再发送消息。",
          placeholder: "描述您想构建的内容，支持 /命令、@文件 和 $skill ...",
          hint: canSend
            ? "Ctrl+回车发送，回车换行；/ 是本地命令，@ 文件、$ skill 为辅助输入"
            : "当前未选中线程",
          send: "发送",
          stop: "停止当前任务"
        }
      : {
          label: "Chat",
          current: "Current Thread",
          description: "Streaming output, commands, and file changes appear here.",
          emptyTitle: "How can I help you code today?",
          emptyText: canSend
            ? "The selected thread is loading, or it does not have messages yet."
            : "Select a thread or create a new one before sending a message.",
          placeholder: "Describe what you want to build. Supports /commands, @files and $skills ...",
          hint: canSend
            ? "Ctrl+Enter to send, Enter for a new line. / is local UI command; @ and $ are assisted"
            : "No thread selected",
          send: "Send",
          stop: "Stop Task"
        };

  useEffect(() => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? prompt.length;
    const nextToken = findActiveComposerToken(prompt, cursor);
    setActiveToken(nextToken);
  }, [prompt]);

  useEffect(() => {
    let cancelled = false;
    const mcpMode = isMcpPrompt(prompt);

    async function loadSuggestions(token: ActiveComposerToken) {
      if (mcpMode) {
        const mcp = await api.searchComposerMcp(prompt);
        if (cancelled) {
          return;
        }
        setSuggestions([
          ...mcp.servers.map<ComposerSuggestion>((entry) => ({
            kind: "mcpServer",
            key: `server:${entry.name}`,
            value: entry.name,
            label: `/mcp ${entry.name}`,
            detail: entry.description || entry.status
          })),
          ...mcp.tools.map<ComposerSuggestion>((entry) => ({
            kind: "mcpTool",
            key: `tool:${entry.server}:${entry.name}`,
            value: `${entry.server} ${entry.name}`,
            label: `/mcp ${entry.server} ${entry.name}`,
            detail: entry.description || entry.server
          }))
        ]);
        setSelectedSuggestionIndex(0);
        return;
      }

      if (token.trigger === "/") {
        setSuggestions(commandSuggestions(token.query, appServerCatalog ?? undefined));
        setSelectedSuggestionIndex(0);
        return;
      }

      try {
        if (token.trigger === "@") {
          const files = await api.searchComposerFiles(token.query);
          if (cancelled) {
            return;
          }
          setSuggestions(
            files.map<ComposerSuggestion>((entry: WorkspaceFileSuggestion) => ({
              kind: "file",
              key: entry.path,
              value: entry.path,
              label: `@${entry.path}`,
              detail: entry.path
            }))
          );
          setSelectedSuggestionIndex(0);
          return;
        }

        const skills = await api.searchComposerSkills(token.query);
        if (cancelled) {
          return;
        }
        setSuggestions(
          skills.map<ComposerSuggestion>((entry: SkillSuggestion) => ({
            kind: "skill",
            key: entry.id,
            value: entry.name,
            label: `$${entry.name}`,
            detail: entry.description || entry.path
          }))
        );
        setSelectedSuggestionIndex(0);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
        }
      }
    }

    if (!activeToken && !mcpMode) {
      setSuggestions([]);
      setSelectedSuggestionIndex(0);
      return () => {
        cancelled = true;
      };
    }

    void loadSuggestions(activeToken ?? { trigger: "/", query: "", start: 0, end: prompt.length });
    return () => {
      cancelled = true;
    };
  }, [activeToken, appServerCatalog, prompt]);

  const applySuggestion = (suggestion: ComposerSuggestion) => {
    if (!activeToken) {
      return;
    }
    if (suggestion.kind === "command") {
      if (suggestion.commandId === "skills") {
        setPrompt("$");
      } else if (suggestion.commandId === "mcp") {
        setPrompt("/mcp ");
      } else {
        onSlashCommand?.(suggestion.commandId);
        setPrompt("");
      }
      setSuggestions([]);
      setActiveToken(null);
      setSelectedSuggestionIndex(0);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return;
    }

    if (suggestion.kind === "mcpServer") {
      setPrompt(`/mcp ${suggestion.value} `);
      setSuggestions([]);
      setActiveToken(null);
      setSelectedSuggestionIndex(0);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const caret = `/mcp ${suggestion.value} `.length;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return;
    }

    if (suggestion.kind === "mcpTool") {
      setPrompt(`/mcp ${suggestion.value} `);
      setSuggestions([]);
      setActiveToken(null);
      setSelectedSuggestionIndex(0);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const caret = `/mcp ${suggestion.value} `.length;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return;
    }

    const nextPrompt = replaceComposerToken(prompt, activeToken, suggestion.value);
    setPrompt(nextPrompt);
    setSuggestions([]);
    setActiveToken(null);
    setSelectedSuggestionIndex(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      const caret = activeToken.start + suggestion.value.length + 2;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const hasSuggestions = Boolean(activeToken) && suggestions.length > 0;

  const maybeHandleSlashCommand = async () => {
    const nextPrompt = prompt.trim();
    const matched = /^\/([a-z-]+)$/.exec(nextPrompt);
    if (!matched) {
      return false;
    }
    const command = matched[1] as SlashCommandId;
    if (command === "skills") {
      setPrompt("$");
      return true;
    }
    if (command === "mcp") {
      setPrompt("/mcp ");
      return true;
    }
    if (
      commandSuggestions(command, appServerCatalog ?? undefined).some(
        (entry) => entry.kind === "command" && entry.commandId === command
      )
    ) {
      onSlashCommand?.(command);
      setPrompt("");
      setSuggestions([]);
      setActiveToken(null);
      setSelectedSuggestionIndex(0);
      return true;
    }
    return false;
  };

  const visibleDeltas = useMemo(
    () =>
      Object.entries(liveDeltas).filter(
        ([, delta]) => delta.threadId === detail?.id && delta.item.type !== "userMessage"
      ),
    [detail?.id, liveDeltas]
  );
  const turns = detail?.turns || [];

  type MixedItem =
    | { kind: "turn"; id: string; turn: ThreadTurn; isLatest: boolean }
    | { kind: "pending"; id: string; prompt: string }
    | { kind: "liveDeltas"; id: string; deltas: typeof visibleDeltas };

  const mixedData = useMemo<MixedItem[]>(() => {
    const data: MixedItem[] = turns.map((turn, index) => ({
      kind: "turn",
      id: `turn-${turn.id}`,
      turn,
      isLatest: index === turns.length - 1
    }));
    if (pendingPrompt) {
      data.push({ kind: "pending", id: "pending-prompt", prompt: pendingPrompt });
    }
    if (visibleDeltas.length > 0) {
      data.push({ kind: "liveDeltas", id: "live-deltas", deltas: visibleDeltas });
    }
    return data;
  }, [turns, pendingPrompt, visibleDeltas]);
  const shouldShowEmptyState = !detailRefreshing && mixedData.length === 0;

  return (
    <section className="flex min-h-[440px] h-full flex-col bg-chat-bg relative overflow-hidden xl:h-full xl:min-h-0">
      <div className="flex-1 w-full h-full min-h-0 relative">
        <Virtuoso
          ref={virtuosoRef}
          atBottomStateChange={setAtBottom}
          className="h-full w-full custom-scroll"
          data={mixedData}
          followOutput="auto"
          initialTopMostItemIndex={Math.max(0, mixedData.length - 1)}
          components={{
            Header: () => (
              shouldShowEmptyState ? (
                <div className="flex h-64 flex-col items-center justify-center text-center opacity-50 space-y-4 px-6 pt-6">
                  <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent/10 text-accent">
                    <Sparkles size={32} />
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-text-primary">{t.emptyTitle}</h3>
                    <p className="mt-2 max-w-md text-sm text-text-secondary">{t.emptyText}</p>
                  </div>
                </div>
              ) : <div className="h-6" />
            ),
            Footer: () => <div className="h-6" />
          }}
          itemContent={(index, item) => {
            if (item.kind === "turn") {
              return (
                 <div className={item.isLatest ? "pb-2" : ""}>
                    <TurnItem turn={item.turn} isLatest={item.isLatest} />
                 </div>
              );
            }
            if (item.kind === "pending") {
              return (
                <div className="px-6 mb-4">
                  <div className="w-full p-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary shadow-sm text-left">
                    <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary font-semibold">
                      <User size={14} /> YOU
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-[15px] text-text-primary/90">
                      {item.prompt}
                    </pre>
                  </div>
                </div>
              );
            }
            if (item.kind === "liveDeltas") {
              return (
                <div className="px-6 pb-2">
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col w-full">
                    <div className="flex-1 min-w-0 space-y-2">
                      {item.deltas.map(([itemId, delta]) => (
                        <div key={itemId}>
                          <div className="flex items-center gap-1 mb-2 px-1">
                            <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                            <span className="ml-2 text-[10px] uppercase text-text-secondary">streaming</span>
                          </div>
                          <LiveItemCard item={delta.item} stream={delta.stream} text={delta.text} />
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </div>
              );
            }
            return null;
          }}
        />

        {/* Scroll to bottom button */}
        <AnimatePresence>
          {!atBottom && mixedData.length > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => {
                 virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
              }}
              className="absolute bottom-6 right-6 p-2.5 bg-accent/80 hover:bg-accent text-white rounded-full shadow-xl z-20 backdrop-blur-sm transition-all border border-white/10"
              title="滚动到最新"
            >
              <ArrowDown size={18} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Glow Input Area */}
      <div className="p-6 bg-gradient-to-t from-chat-bg via-chat-bg to-transparent relative z-10 shrink-0">
         <form 
            className="w-full relative group flex flex-col items-center"
            onSubmit={async (e) => {
               e.preventDefault();
               if (await maybeHandleSlashCommand()) {
                 return;
               }
               await handleSubmitPrompt();
            }}
         >
            {/* Glowing Backdrop */}
            <div className="absolute inset-0 bg-accent/20 blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity rounded-2xl pointer-events-none" />
            
            <div className="relative w-full flex flex-col bg-white/5 border border-border rounded-2xl p-2 focus-within:border-accent/50 transition-all shadow-lg">
               {hasSuggestions && (
                 <div className="mx-2 mt-2 rounded-xl border border-border bg-sidebar/95 shadow-2xl overflow-hidden">
                   <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border/60">
                     {activeToken?.trigger === "/" ? "命令" : activeToken?.trigger === "@" ? "文件" : "Skill"}
                   </div>
                   <div className="max-h-64 overflow-y-auto py-1">
                     {suggestions.map((suggestion, index) => (
                       <button
                         key={suggestion.key}
                         type="button"
                         className={cn(
                           "w-full px-3 py-2 text-left transition-colors",
                           index === selectedSuggestionIndex ? "bg-accent/15" : "hover:bg-white/5"
                         )}
                         onMouseDown={(event) => {
                           event.preventDefault();
                           applySuggestion(suggestion);
                         }}
                       >
                         <div className="text-sm text-text-primary">{suggestion.label}</div>
                         <div className="text-xs text-text-secondary truncate">{suggestion.detail}</div>
                       </button>
                     ))}
                   </div>
                 </div>
               )}
               <textarea
                 ref={textareaRef}
                 id="chat-prompt"
                 name="chat-prompt"
                 className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 px-4 resize-none min-h-[56px] max-h-40 text-text-primary outline-none"
                 placeholder={t.placeholder}
                 value={prompt}
                 onChange={(event) => {
                   setPrompt(event.target.value);
                   const cursor = event.target.selectionStart ?? event.target.value.length;
                   setActiveToken(findActiveComposerToken(event.target.value, cursor));
                 }}
                 onClick={(event) => {
                   const target = event.currentTarget;
                   setActiveToken(findActiveComposerToken(target.value, target.selectionStart ?? target.value.length));
                 }}
                 onSelect={(event) => {
                   const target = event.currentTarget;
                   setActiveToken(findActiveComposerToken(target.value, target.selectionStart ?? target.value.length));
                 }}
                 onKeyDown={async (event) => {
                   if (hasSuggestions) {
                     if (event.key === "ArrowDown") {
                       event.preventDefault();
                       setSelectedSuggestionIndex((current) => (current + 1) % suggestions.length);
                       return;
                     }
                     if (event.key === "ArrowUp") {
                       event.preventDefault();
                       setSelectedSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
                       return;
                     }
                     if (event.key === "Enter" || event.key === "Tab") {
                       event.preventDefault();
                       applySuggestion(suggestions[selectedSuggestionIndex]);
                       return;
                     }
                     if (event.key === "Escape") {
                       event.preventDefault();
                       setSuggestions([]);
                       setActiveToken(null);
                       return;
                     }
                   }
                   if (event.key === "Enter" && event.ctrlKey) {
                     event.preventDefault();
                     if (await maybeHandleSlashCommand()) {
                       return;
                     }
                     await handleSubmitPrompt();
                   }
                 }}
               />
               
               <div className="flex justify-between items-center px-4 pt-2 pb-1 border-t border-white/5">
                 <p className="text-[10px] text-text-secondary hidden sm:block">
                   {t.hint}
                 </p>
                 <div className="flex gap-2 ml-auto">
                    {turns.at(-1)?.status === "inProgress" && (
                       <button
                         type="button"
                         className="p-2 text-xs text-red-400 bg-red-400/10 rounded-xl hover:bg-red-400/20 transition-all"
                         onClick={onInterrupt}
                       >
                         {t.stop}
                       </button>
                    )}
                    <button 
                     type="submit"
                      disabled={!prompt.trim() || !canSend}
                      title={t.send}
                      aria-label={t.send}
                      className="p-2.5 bg-accent text-white rounded-xl hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md"
                    >
                      <Send size={16} />
                    </button>
                 </div>
               </div>
            </div>
         </form>
      </div>

    </section>
  );
}
