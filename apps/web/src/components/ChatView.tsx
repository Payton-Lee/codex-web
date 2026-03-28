import { useMemo, useState, useRef, useEffect } from "react";
import { Bot, FileCode, Send, Sparkles, Terminal, ChevronDown, ChevronUp, ArrowDown, User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { ThreadDetail } from "../shared";
import { cn } from "../lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

type ThreadTurn = ThreadDetail["turns"][0];

interface Props {
  detail: ThreadDetail | null;
  liveDeltas: Record<string, { stream: string; text: string; threadId: string; turnId: string }>;
  pendingPrompt?: string | null;
  onSend(prompt: string): Promise<void> | void;
  onInterrupt(): void;
  language: "zh" | "en";
  workspaceName?: string;
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

export function ChatView({ detail, liveDeltas, pendingPrompt, onSend, onInterrupt, language }: Props) {
  const [prompt, setPrompt] = useState("");
  const virtuosoRef = useRef<VirtuosoHandle>(null);
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
          emptyText: "让我帮你生成功能、修复 Bug、执行命令并展示代码差异审批。",
          placeholder: "描述您想构建的内容...",
          hint: "回车发送，Shift+回车换行",
          send: "发送",
          stop: "停止当前任务"
        }
      : {
          label: "Chat",
          current: "Current Thread",
          description: "Streaming output, commands, and file changes appear here.",
          emptyTitle: "How can I help you code today?",
          emptyText: "Ask me to build features, fix bugs, run commands, and review file diffs.",
          placeholder: "Describe what you want to build...",
          hint: "Enter to send, Shift+Enter for a new line",
          send: "Send",
          stop: "Stop Task"
        };

  const visibleDeltas = useMemo(
    () => Object.entries(liveDeltas).filter(([, delta]) => delta.threadId === detail?.id),
    [detail?.id, liveDeltas]
  );
  const turns = detail?.turns || [];

  return (
    <section className="flex min-h-[440px] h-full flex-col bg-chat-bg relative overflow-hidden xl:h-full xl:min-h-0">
      
      {/* Scrollable messages area with Virtuoso (Virtual List implementation) */}
      <div className="flex-1 w-full h-full min-h-0 relative">
        <Virtuoso
          ref={virtuosoRef}
          atBottomStateChange={(bottom) => setAtBottom(bottom)}
          className="h-full w-full custom-scroll"
          data={turns}
          initialTopMostItemIndex={Math.max(0, turns.length - 1)}
          followOutput="smooth"
          components={{
            Header: () => (
              !turns.length ? (
                <div className="flex h-64 flex-col items-center justify-center text-center opacity-50 space-y-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent/10 text-accent">
                    <Sparkles size={32} />
                  </div>
                  <div>
                     <h3 className="text-xl font-semibold text-text-primary">{t.emptyTitle}</h3>
                     <p className="mt-2 max-w-md text-sm text-text-secondary">{t.emptyText}</p>
                  </div>
                </div>
              ) : <div className="h-6" /> // Top padding
            ),
            Footer: () => (
              <div className="px-6 pb-6 mt-4">
                {pendingPrompt ? (
                  <div className="w-full p-4 mb-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary shadow-sm text-left">
                    <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary font-semibold">
                      <User size={14} /> YOU
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-[15px] text-text-primary/90">
                      {pendingPrompt}
                    </pre>
                  </div>
                ) : null}
                {visibleDeltas.length > 0 && (
                  <motion.div 
                     initial={{ opacity: 0 }}
                     animate={{ opacity: 1 }}
                     className="flex flex-col w-full"
                  >
                    <div className="flex-1 min-w-0 space-y-2">
                       {visibleDeltas.map(([itemId, delta]) => (
                         <div key={itemId} className="w-full p-4 rounded-xl text-sm leading-relaxed bg-white/5 border border-border text-text-primary text-left shadow-sm">
                            <div className="flex items-center gap-1 mb-2">
                               <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                               <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                               <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                               <span className="ml-2 text-[10px] uppercase text-text-secondary">{delta.stream}</span>
                            </div>
                            <div className="max-w-none text-text-primary overflow-hidden break-words mt-2">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={GlobalMarkdownComponents}>
                                {delta.text}
                              </ReactMarkdown>
                            </div>
                         </div>
                       ))}
                    </div>
                  </motion.div>
                )}
              </div>
            )
          }}
          itemContent={(index, turn) => {
            const isLatest = index === turns.length - 1;
            return <TurnItem turn={turn} isLatest={isLatest} />;
          }}
        />

        {/* Scroll to bottom button */}
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => {
                 virtuosoRef.current?.scrollTo({ top: 9999999, behavior: 'smooth' });
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
               await handleSubmitPrompt();
            }}
         >
            {/* Glowing Backdrop */}
            <div className="absolute inset-0 bg-accent/20 blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity rounded-2xl pointer-events-none" />
            
            <div className="relative w-full flex flex-col bg-white/5 border border-border rounded-2xl p-2 focus-within:border-accent/50 transition-all shadow-lg">
               <textarea
                 id="chat-prompt"
                 name="chat-prompt"
                 className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 px-4 resize-none min-h-[56px] max-h-40 text-text-primary outline-none"
                 placeholder={t.placeholder}
                 value={prompt}
                 onChange={(event) => setPrompt(event.target.value)}
                 onKeyDown={async (event) => {
                   if (event.key === "Enter" && !event.shiftKey) {
                     event.preventDefault();
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
                      disabled={!prompt.trim()}
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
