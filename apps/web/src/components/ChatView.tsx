import { memo, useMemo, useState, useRef, useEffect } from 'react';
import {
    Bot,
    FileCode,
    Send,
    Sparkles,
    Terminal,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    Copy,
    Check,
    ArrowDown,
    User,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback } from 'react';
import type {
    AppServerCatalog,
    SkillSuggestion,
    ThreadDetail,
    ThreadItem,
    WorkspaceFileSuggestion,
} from '../shared';
import { cn } from '../lib/utils';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { api } from '../api';
import {
    commandSuggestions,
    findActiveComposerToken,
    isMcpPrompt,
    replaceComposerToken,
    type SlashCommandId,
    type ActiveComposerToken,
    type ComposerSuggestion,
} from '../lib/composer';

type ThreadTurn = ThreadDetail['turns'][0];
const TOP_PRELOAD_THRESHOLD_PX = 48;
const AUTO_PRELOAD_COOLDOWN_MS = 900;
const AUTO_PRELOAD_SUPPRESS_AFTER_RESTORE_MS = 800;
const INITIAL_HISTORY_AUTOLOAD_TURN_COUNT = 5;
const MIN_SCROLL_TOP_TO_RESTORE_PX = 120;

interface Props {
    detail: ThreadDetail | null;
    liveDeltas: Record<
        string,
        {
            stream: string;
            text: string;
            threadId: string;
            turnId: string;
            item: ThreadItem;
        }
    >;
    pendingPrompt?: string | null;
    detailRefreshing?: boolean;
    historyHasMore?: boolean;
    historyLoadingMore?: boolean;
    onLoadOlderTurns?(): void;
    onSend(prompt: string): Promise<void> | void;
    onInterrupt(): void;
    onSlashCommand?(command: SlashCommandId): void;
    language: 'zh' | 'en';
    workspaceName?: string;
    canSend?: boolean;
    sending?: boolean;
    appServerCatalog?: AppServerCatalog | null;
}

function itemDisplayText(item: ThreadTurn['items'][number]): string {
    if (typeof item.text === 'string' && item.text.trim()) {
        return item.text;
    }
    const content = Array.isArray(item.content)
        ? (item.content as unknown as Array<Record<string, unknown>>)
        : null;
    if (!content) {
        return '';
    }
    return content
        .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
        .join('')
        .trim();
}

function displayChangeKind(kind: unknown): string {
    if (typeof kind === 'string') {
        return kind;
    }
    if (!kind || typeof kind !== 'object') {
        return 'unknown';
    }
    const candidate = kind as { type?: unknown; move_path?: unknown };
    const type =
        typeof candidate.type === 'string' ? candidate.type : 'unknown';
    const movePath =
        typeof candidate.move_path === 'string' &&
        candidate.move_path.length > 0
            ? ` -> ${candidate.move_path}`
            : '';
    return `${type}${movePath}`;
}

const GlobalMarkdownComponents: Components = {
    h1: ({ ref, ...props }) => (
        <h1
            className="text-2xl font-bold mt-6 mb-4 text-text-primary"
            {...props}
        />
    ),
    h2: ({ ref, ...props }) => (
        <h2
            className="text-xl font-bold mt-6 mb-3 text-text-primary border-b border-border pb-2"
            {...props}
        />
    ),
    h3: ({ ref, ...props }) => (
        <h3
            className="text-lg font-bold mt-5 mb-3 text-text-primary"
            {...props}
        />
    ),
    h4: ({ ref, ...props }) => (
        <h4
            className="text-base font-bold mt-4 mb-2 text-text-primary"
            {...props}
        />
    ),
    p: ({ ref, ...props }) => (
        <p className="mb-4 leading-relaxed text-text-primary/90" {...props} />
    ),
    ul: ({ ref, ...props }) => (
        <ul
            className="mb-4 pl-6 list-disc space-y-1 text-text-primary/90"
            {...props}
        />
    ),
    ol: ({ ref, ...props }) => (
        <ol
            className="mb-4 pl-6 list-decimal space-y-1 text-text-primary/90"
            {...props}
        />
    ),
    li: ({ ref, ...props }) => <li className="leading-relaxed" {...props} />,
    a: ({ ref, ...props }) => (
        <a className="text-accent hover:underline font-medium" {...props} />
    ),
    strong: ({ ref, ...props }) => (
        <strong className="font-semibold text-text-primary" {...props} />
    ),
    blockquote: ({ ref, ...props }) => (
        <blockquote
            className="border-l-4 border-accent/50 pl-4 py-1 my-4 bg-accent/5 rounded-r text-text-primary"
            {...props}
        />
    ),
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
                    customStyle={{
                        margin: 0,
                        padding: '1rem',
                        background: 'var(--chat-bg)',
                        fontSize: '0.85rem',
                        lineHeight: '1.5',
                    }}
                />
            </div>
        ) : (
            <code
                className="bg-white/10 text-accent px-1.5 py-0.5 rounded-md text-sm font-mono"
                {...props}
            >
                {children}
            </code>
        );
    },
};

function itemBadgeLabel(
    item: ThreadTurn['items'][number] | ThreadItem,
    language: 'zh' | 'en' = 'zh',
): string {
    if (item.type === 'agentMessage') {
        return language === 'zh' ? '助手' : 'Assistant';
    }
    if (item.type === 'reasoning') {
        return language === 'zh' ? '思考' : 'Reasoning';
    }
    if (item.type === 'commandExecution') {
        return language === 'zh' ? '命令' : 'Command';
    }
    if (item.type === 'fileChange') {
        return language === 'zh' ? '文件变更' : 'File Change';
    }
    return item.type;
}

function summarizeBlockText(text: string, maxLines = 2, maxChars = 140): string {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return '';
    }
    const lines = normalized.split('\n');
    const clippedLines = lines.slice(0, maxLines).join('\n');
    const clipped = clippedLines.slice(0, maxChars);
    return clipped.length < normalized.length ? `${clipped}...` : clipped;
}

function shouldCollapseBlock(text: string, minLines = 8, minChars = 320): boolean {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return false;
    }
    const lines = normalized.split('\n').length;
    return lines >= minLines || normalized.length >= minChars;
}

function executionSummaryText(
    command: string | undefined,
    output: string | undefined,
    language: 'zh' | 'en',
): string {
    const preferred = (output && output.trim()) || (command && command.trim()) || '';
    if (!preferred) {
        return language === 'zh' ? '暂无执行内容' : 'No execution content';
    }
    return summarizeBlockText(preferred, 2, 120);
}

function executionTypeLabel(
    command: string | undefined,
    output: string | undefined,
    language: 'zh' | 'en',
): string {
    if (command && output) {
        return language === 'zh' ? '命令 + 输出' : 'Command + Output';
    }
    if (output) {
        return language === 'zh' ? '输出' : 'Output';
    }
    if (command) {
        return language === 'zh' ? '命令' : 'Command';
    }
    return language === 'zh' ? '结果' : 'Result';
}

const ExpandableTextBlock = memo(function ExpandableTextBlock({
    label,
    text,
    tone = 'secondary',
    language,
    className,
    forceCollapsed = false,
}: {
    label: string;
    text: string;
    tone?: 'primary' | 'secondary';
    language: 'zh' | 'en';
    className?: string;
    forceCollapsed?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const collapsible = forceCollapsed || shouldCollapseBlock(text);
    const summary = summarizeBlockText(text);

    return (
        <div
            className={cn(
                'overflow-hidden rounded-2xl bg-[color:color-mix(in_srgb,var(--chat-card-muted)_52%,transparent)]',
                className,
            )}
        >
            {collapsible && !expanded ? (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-white/[0.03]"
                >
                    <ChevronRight size={14} className="mt-0.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                                {label}
                            </span>
                            <span className="text-[10px] text-text-secondary/70">
                                {language === 'zh' ? '点击展开' : 'Click to expand'}
                            </span>
                        </div>
                        <pre
                            className={cn(
                                'overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-5',
                                tone === 'primary'
                                    ? 'text-text-primary'
                                    : 'text-text-secondary',
                            )}
                        >
                            {summary}
                        </pre>
                    </div>
                </button>
            ) : (
                <>
                    <button
                        type="button"
                        onClick={() => {
                            if (collapsible) {
                                setExpanded((current) => !current);
                            }
                        }}
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left',
                            collapsible
                                ? 'cursor-pointer hover:bg-white/[0.03]'
                                : 'cursor-default',
                        )}
                    >
                        {collapsible ? (
                            <ChevronDown size={14} className="shrink-0 text-accent" />
                        ) : (
                            <span className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                            {label}
                        </span>
                        {collapsible ? (
                            <span className="ml-auto text-[11px] text-text-secondary">
                                {language === 'zh' ? '收起' : 'Collapse'}
                            </span>
                        ) : null}
                    </button>
                    <pre
                        className={cn(
                            'overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs',
                            tone === 'primary'
                                ? 'text-text-primary'
                                : 'text-text-secondary',
                        )}
                    >
                        {text}
                    </pre>
                </>
            )}
        </div>
    );
});

const CommandResultCard = memo(function CommandResultCard({
    command,
    output,
    language,
    className,
}: {
    command?: string;
    output?: string;
    language: 'zh' | 'en';
    className?: string;
}) {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const summary = executionSummaryText(command, output, language);
    const typeLabel = executionTypeLabel(command, output, language);
    const copyPayload = [command?.trim(), output?.trim()].filter(Boolean).join('\n\n');

    const handleCopy = async () => {
        if (!copyPayload) {
            return;
        }
        try {
            await navigator.clipboard.writeText(copyPayload);
            setCopied(true);
            window.setTimeout(() => {
                setCopied(false);
            }, 1200);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div
            className={cn(
                'overflow-hidden rounded-2xl bg-[color:color-mix(in_srgb,var(--chat-card-soft)_38%,var(--chat-card-muted))] ring-1 ring-white/[0.04]',
                className,
            )}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <button
                    type="button"
                    onClick={() => setExpanded((current) => !current)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left hover:text-text-primary"
                >
                    {expanded ? (
                        <ChevronDown size={14} className="mt-0.5 shrink-0 text-accent" />
                    ) : (
                        <ChevronRight size={14} className="mt-0.5 shrink-0 text-accent" />
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                                {language === 'zh' ? '结果' : 'Result'}
                            </span>
                            <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-text-secondary/80">
                                {typeLabel}
                            </span>
                            <span className="text-[10px] text-text-secondary/70">
                                {expanded
                                    ? language === 'zh'
                                        ? '点击收起'
                                        : 'Click to collapse'
                                    : language === 'zh'
                                      ? '点击展开'
                                      : 'Click to expand'}
                            </span>
                        </div>
                        <pre className="overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-text-primary/88">
                            {summary}
                        </pre>
                    </div>
                </button>
                {copyPayload ? (
                    <button
                        type="button"
                        onClick={handleCopy}
                        className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-white/[0.05] hover:text-text-primary"
                        title={language === 'zh' ? '复制结果' : 'Copy result'}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div className="space-y-3 px-3 pb-3">
                    {command ? (
                        <ExpandableTextBlock
                            label={language === 'zh' ? '命令内容' : 'Command'}
                            text={command}
                            tone="primary"
                            language={language}
                        />
                    ) : null}
                    {output ? (
                        <ExpandableTextBlock
                            label={language === 'zh' ? '执行结果' : 'Output'}
                            text={output}
                            language={language}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
});

const TurnItem = memo(function TurnItem({
    turn,
    isLatest,
    language,
}: {
    turn: ThreadTurn;
    isLatest: boolean;
    language: 'zh' | 'en';
}) {
    const [expanded, setExpanded] = useState(
        isLatest || turn.status === 'inProgress',
    );
    const lastAutoExpandedTurnIdRef = useRef<string | null>(null);

    useEffect(() => {
        const shouldAutoExpand = isLatest || turn.status === 'inProgress';
        if (shouldAutoExpand) {
            setExpanded(true);
            lastAutoExpandedTurnIdRef.current = turn.id;
            return;
        }
        if (lastAutoExpandedTurnIdRef.current === turn.id) {
            setExpanded(false);
            lastAutoExpandedTurnIdRef.current = null;
        }
    }, [isLatest, turn.id, turn.status]);

    const hasAIOrCommandItems = turn.items.some(
        (i) => i.type !== 'userMessage',
    );

    // Determine summary to display when collapsed
    let summaryText = '助手工作中，点击展开详情...';
    if (hasAIOrCommandItems) {
        const agentItem = turn.items.find(
            (i) =>
                i.type === 'agentMessage' &&
                typeof i.text === 'string' &&
                i.text,
        );
        if (agentItem?.text) {
            summaryText = agentItem.text.replace(/\n|#/g, ' ').substring(0, 80);
            if (agentItem.text.length > 80) summaryText += '...';
        } else {
            const cmdItem = turn.items.find(
                (i) => i.type === 'commandExecution' || i.type === 'fileChange',
            );
            if (cmdItem)
                summaryText =
                    `处理了相关代码变更或命令: ${cmdItem.command || ''}`.substring(
                        0,
                        80,
                    );
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 pb-6 pt-2">
            {turn.items.map((item) => {
                const userText = itemDisplayText(item);
                if (item.type === 'userMessage' && userText) {
                    return (
                        <div key={item.id} className="flex justify-end">
                            <div className="max-w-[58%] rounded-[18px] bg-[color:color-mix(in_srgb,var(--chat-card-soft)_58%,transparent)] px-4 py-3 text-left shadow-[0_4px_12px_rgba(0,0,0,0.06)]">
                                <div className="mb-2 flex items-center justify-end gap-2 text-[11px] font-medium text-text-secondary">
                                    <span>{language === 'zh' ? '你' : 'You'}</span>
                                    <User size={13} />
                                </div>
                                <pre className="whitespace-pre-wrap font-sans text-[14px] leading-6 text-text-primary">
                                    {userText}
                                </pre>
                            </div>
                        </div>
                    );
                }
                return null;
            })}

            {hasAIOrCommandItems &&
                (expanded ? (
                    <div className="space-y-4">
                        {turn.items.map((item) => {
                            if (item.type === 'userMessage') return null;

                            return (
                                <div
                                    key={item.id}
                                    className="group relative rounded-[24px] bg-[color:color-mix(in_srgb,var(--chat-card)_38%,transparent)] px-2 py-3 text-left text-sm leading-relaxed text-text-primary shadow-none"
                                >
                                    {!isLatest && (
                                        <button
                                            onClick={() => setExpanded(false)}
                                            className="absolute right-1 top-2 rounded-full bg-white/[0.03] p-1.5 text-text-secondary opacity-0 transition-opacity hover:bg-white/[0.06] group-hover:opacity-100"
                                            title={
                                                language === 'zh'
                                                    ? '折叠'
                                                    : 'Collapse'
                                            }
                                        >
                                            <ChevronUp size={14} />
                                        </button>
                                    )}

                                    <div className="mb-3 flex items-center gap-2 pr-8 text-[10px] font-medium tracking-[0.12em] text-text-secondary uppercase">
                                        {item.type === 'agentMessage' ? (
                                            <Bot size={13} className="text-accent" />
                                        ) : null}
                                        {item.type === 'commandExecution' ? (
                                            <Terminal
                                                size={13}
                                                className="text-accent"
                                            />
                                        ) : null}
                                        {item.type === 'fileChange' ? (
                                            <FileCode
                                                size={13}
                                                className="text-accent"
                                            />
                                        ) : null}
                                        <span>{itemBadgeLabel(item, language)}</span>
                                        {item.status ? (
                                            <span className="rounded-full bg-white/[0.04] px-2 py-0.5 normal-case tracking-normal">
                                                {item.status}
                                            </span>
                                        ) : null}
                                    </div>

                                    {itemDisplayText(item) ? (
                                        item.type === 'agentMessage' ? (
                                            <div className="max-w-none text-text-primary overflow-hidden break-words">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={
                                                        GlobalMarkdownComponents
                                                    }
                                                >
                                                    {itemDisplayText(item)}
                                                </ReactMarkdown>
                                            </div>
                                        ) : (
                                            <pre className="whitespace-pre-wrap text-sm font-sans break-words">
                                                {itemDisplayText(item)}
                                            </pre>
                                        )
                                    ) : null}
                                    {item.command || item.aggregatedOutput ? (
                                        <CommandResultCard
                                            command={item.command}
                                            output={
                                                item.aggregatedOutput ?? undefined
                                            }
                                            language={language}
                                            className="mb-1"
                                        />
                                    ) : null}
                                    {item.changes?.length ? (
                                        <div className="mt-4 overflow-hidden rounded-2xl bg-[color:color-mix(in_srgb,var(--chat-card-soft)_48%,transparent)]">
                                            <div className="flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary">
                                                <span>
                                                    {language === 'zh'
                                                        ? `${item.changes.length} 个文件已变更`
                                                        : `${item.changes.length} file changes`}
                                                </span>
                                                <span className="text-xs text-text-secondary">
                                                    {language === 'zh'
                                                        ? '摘要'
                                                        : 'Summary'}
                                                </span>
                                            </div>
                                            <div className="divide-y divide-white/4">
                                            {item.changes.map((change) => (
                                                <div
                                                    key={change.path}
                                                    className="flex gap-3 px-4 py-3 font-mono text-xs text-text-secondary"
                                                >
                                                    <span className="shrink-0 text-accent">
                                                        {displayChangeKind(
                                                            change.kind,
                                                        )}
                                                    </span>
                                                    <span className="truncate">
                                                        {change.path}
                                                    </span>
                                                </div>
                                            ))}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <button
                        onClick={() => setExpanded(true)}
                        className="w-full rounded-[20px] bg-[color:color-mix(in_srgb,var(--chat-card)_34%,transparent)] p-4 text-left text-text-secondary shadow-none transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-card-soft)_54%,transparent)] hover:text-text-primary"
                    >
                        <div className="flex-1 min-w-0">
                            <p className="flex items-center gap-2 truncate text-sm font-medium">
                                <Bot
                                    size={13}
                                    className="shrink-0 text-accent"
                                />
                                <span className="truncate">{summaryText}</span>
                            </p>
                        </div>
                        <ChevronDown
                            size={14}
                            className="opacity-50 group-hover:opacity-100 shrink-0"
                        />
                    </button>
                ))}
        </div>
    );
});

const LiveItemCard = memo(function LiveItemCard({
    item,
    stream,
    text,
    language,
}: {
    item: ThreadItem;
    stream: string;
    text: string;
    language: 'zh' | 'en';
}) {
    const displayText =
        text || itemDisplayText(item as ThreadTurn['items'][number]);

    return (
        <div className="rounded-[24px] bg-[color:color-mix(in_srgb,var(--chat-card)_38%,transparent)] px-2 py-3 text-left text-sm leading-relaxed text-text-primary shadow-none">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                {item.type === 'agentMessage' ? (
                    <Bot size={13} className="text-accent" />
                ) : null}
                {item.type === 'commandExecution' ? (
                    <Terminal size={13} className="text-accent" />
                ) : null}
                {item.type === 'fileChange' ? (
                    <FileCode size={13} className="text-accent" />
                ) : null}
                <span>{itemBadgeLabel(item, language)}</span>
                {item.status ? (
                    <span className="rounded-full bg-white/[0.04] px-2 py-0.5 normal-case tracking-normal">
                        {item.status}
                    </span>
                ) : null}
                <span className="ml-auto rounded-full bg-white/[0.04] px-2 py-0.5 normal-case tracking-normal text-text-secondary">
                    {stream}
                </span>
            </div>
            {displayText ? (
                item.type === 'agentMessage' || item.type === 'reasoning' ? (
                    <div className="max-w-none text-text-primary overflow-hidden break-words">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={GlobalMarkdownComponents}
                        >
                            {displayText}
                        </ReactMarkdown>
                    </div>
                ) : (
                    <pre className="whitespace-pre-wrap text-sm font-sans break-words">
                        {displayText}
                    </pre>
                )
            ) : null}
            {item.command ||
            (item.aggregatedOutput && item.aggregatedOutput !== displayText) ? (
                <CommandResultCard
                    command={item.command}
                    output={
                        item.aggregatedOutput && item.aggregatedOutput !== displayText
                            ? item.aggregatedOutput
                            : undefined
                    }
                    language={language}
                    className={displayText ? 'mt-3' : 'mb-3'}
                />
            ) : null}
            {item.changes?.length ? (
                <div className="mt-4 overflow-hidden rounded-2xl bg-[color:color-mix(in_srgb,var(--chat-card-soft)_48%,transparent)]">
                    {item.changes.map((change) => (
                        <div
                            key={change.path}
                            className="flex gap-3 border-b border-white/4 px-4 py-3 font-mono text-xs text-text-secondary last:border-b-0"
                        >
                            <span className="shrink-0 text-accent">
                                {displayChangeKind(change.kind)}:
                            </span>
                            <span className="truncate">{change.path}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
});

const ThinkingCard = memo(function ThinkingCard({
    language,
}: {
    language: 'zh' | 'en';
}) {
    return (
        <div className="rounded-[24px] bg-[color:color-mix(in_srgb,var(--chat-card)_38%,transparent)] px-4 py-4 text-left text-sm leading-relaxed text-text-primary shadow-none">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                <Bot size={13} className="text-accent" />
                <span>{language === 'zh' ? '思考中' : 'Thinking'}</span>
                <span className="ml-auto rounded-full bg-white/[0.04] px-2 py-0.5 normal-case tracking-normal text-text-secondary">
                    {language === 'zh' ? '请稍候' : 'please wait'}
                </span>
            </div>
            <div className="flex items-center gap-1 py-1">
                <span
                    className="h-2 w-2 rounded-full bg-accent animate-bounce"
                    style={{ animationDelay: '0ms' }}
                />
                <span
                    className="h-2 w-2 rounded-full bg-accent animate-bounce"
                    style={{ animationDelay: '150ms' }}
                />
                <span
                    className="h-2 w-2 rounded-full bg-accent animate-bounce"
                    style={{ animationDelay: '300ms' }}
                />
            </div>
            <p className="mt-3 text-sm leading-7 text-text-secondary">
                {language === 'zh'
                    ? '助手正在处理这条消息，回复会在准备好后显示。'
                    : 'The assistant is working on this message and will reply here when ready.'}
            </p>
        </div>
    );
});

function hasRenderableLiveContent(item: ThreadItem, text: string): boolean {
    if (text.trim()) {
        return true;
    }
    if (typeof item.command === 'string' && item.command.trim()) {
        return true;
    }
    if (
        typeof item.aggregatedOutput === 'string' &&
        item.aggregatedOutput.trim()
    ) {
        return true;
    }
    return Array.isArray(item.changes) && item.changes.length > 0;
}

export function ChatView({
    detail,
    liveDeltas,
    pendingPrompt,
    detailRefreshing = false,
    historyHasMore = false,
    historyLoadingMore = false,
    onLoadOlderTurns,
    onSend,
    onInterrupt,
    onSlashCommand,
    language,
    canSend = true,
    sending = false,
    appServerCatalog,
}: Props) {
    const [prompt, setPrompt] = useState('');
    const [activeToken, setActiveToken] = useState<ActiveComposerToken | null>(
        null,
    );
    const [suggestions, setSuggestions] = useState<ComposerSuggestion[]>([]);
    const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [atBottom, setAtBottom] = useState(true);
    const [isNearTop, setIsNearTop] = useState(false);
    const shouldScrollToBottomRef = useRef(false);
    const prependAnchorTurnIdRef = useRef<string | null>(null);
    const prependInFlightRef = useRef(false);
    const initialAutoLoadDoneRef = useRef(false);
    const lastAutoLoadAtRef = useRef(0);
    const wasNearTopRef = useRef(false);
    const lastScrollTopRef = useRef<number | null>(null);
    const suppressAutoPreloadUntilRef = useRef(0);
    const savedScrollTopByThreadRef = useRef<Record<string, number>>({});
    const prependScrollMetricsRef = useRef<{
        scrollTop: number;
        scrollHeight: number;
    } | null>(null);
    const pendingRestoreScrollTopRef = useRef<number | null>(null);

    const getScroller = useCallback(() => {
        return document.querySelector<HTMLDivElement>(
            '.h-full.w-full.custom-scroll',
        );
    }, []);

    const submitPrompt = async () => {
        const nextPrompt = prompt.trim();
        if (!nextPrompt) {
            return;
        }
        setPrompt('');
        try {
            await onSend(nextPrompt);
        } catch (error) {
            setPrompt(nextPrompt);
            throw error;
        }
    };

    const handleSubmitPrompt = async () => {
        try {
            shouldScrollToBottomRef.current = true;
            await submitPrompt();
        } catch {
            // Errors are surfaced through global store error state; keep the draft intact here.
        }
    };

    const t =
        language === 'zh'
            ? {
                  label: 'Chat',
                  current: '当前线程',
                  description:
                      '聊天流式输出、命令执行和文件修改都会在这里展示。',
                  emptyTitle: '今天我能帮你写点什么代码？',
                  emptyText: canSend
                      ? '所选线程正在加载，或者当前线程还没有消息。'
                      : '请先在左侧选择一个线程，或创建新线程后再发送消息。',
                  placeholder:
                      '描述你想构建的内容，支持 /命令、@文件 和 $skill ...',
                  hint: canSend
                      ? 'Ctrl+Enter 发送，Enter 换行。/ 是本地 UI 命令，@ 文件和 $ skill 为辅助输入。'
                      : '当前未选中线程',
                  send: '发送',
                  stop: '停止当前任务',
              }
            : {
                  label: 'Chat',
                  current: 'Current Thread',
                  description:
                      'Streaming output, commands, and file changes appear here.',
                  emptyTitle: 'How can I help you code today?',
                  emptyText: canSend
                      ? 'The selected thread is loading, or it does not have messages yet.'
                      : 'Select a thread or create a new one before sending a message.',
                  placeholder:
                      'Describe what you want to build. Supports /commands, @files and $skills ...',
                  hint: canSend
                      ? 'Ctrl+Enter to send, Enter for a new line. / is local UI command; @ and $ are assisted'
                      : 'No thread selected',
                  send: 'Send',
                  stop: 'Stop Task',
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
                        kind: 'mcpServer',
                        key: `server:${entry.name}`,
                        value: entry.name,
                        label: `/mcp ${entry.name}`,
                        detail: entry.description || entry.status,
                    })),
                    ...mcp.tools.map<ComposerSuggestion>((entry) => ({
                        kind: 'mcpTool',
                        key: `tool:${entry.server}:${entry.name}`,
                        value: `${entry.server} ${entry.name}`,
                        label: `/mcp ${entry.server} ${entry.name}`,
                        detail: entry.description || entry.server,
                    })),
                ]);
                setSelectedSuggestionIndex(0);
                return;
            }

            if (token.trigger === '/') {
                setSuggestions(
                    commandSuggestions(
                        token.query,
                        appServerCatalog ?? undefined,
                    ),
                );
                setSelectedSuggestionIndex(0);
                return;
            }

            try {
                if (token.trigger === '@') {
                    const files = await api.searchComposerFiles(token.query);
                    if (cancelled) {
                        return;
                    }
                    setSuggestions(
                        files.map<ComposerSuggestion>(
                            (entry: WorkspaceFileSuggestion) => ({
                                kind: 'file',
                                key: entry.path,
                                value: entry.path,
                                label: `@${entry.path}`,
                                detail: entry.path,
                            }),
                        ),
                    );
                    setSelectedSuggestionIndex(0);
                    return;
                }

                const skills = await api.searchComposerSkills(token.query);
                if (cancelled) {
                    return;
                }
                setSuggestions(
                    skills.map<ComposerSuggestion>(
                        (entry: SkillSuggestion) => ({
                            kind: 'skill',
                            key: entry.id,
                            value: entry.name,
                            label: `$${entry.name}`,
                            detail: entry.description || entry.path,
                        }),
                    ),
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

        void loadSuggestions(
            activeToken ?? {
                trigger: '/',
                query: '',
                start: 0,
                end: prompt.length,
            },
        );
        return () => {
            cancelled = true;
        };
    }, [activeToken, appServerCatalog, prompt]);

    const applySuggestion = (suggestion: ComposerSuggestion) => {
        if (!activeToken) {
            return;
        }
        if (suggestion.kind === 'command') {
            if (suggestion.commandId === 'skills') {
                setPrompt('$');
            } else if (suggestion.commandId === 'mcp') {
                setPrompt('/mcp ');
            } else {
                onSlashCommand?.(suggestion.commandId);
                setPrompt('');
            }
            setSuggestions([]);
            setActiveToken(null);
            setSelectedSuggestionIndex(0);
            requestAnimationFrame(() => {
                textareaRef.current?.focus();
            });
            return;
        }

        if (suggestion.kind === 'mcpServer') {
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

        if (suggestion.kind === 'mcpTool') {
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

        const nextPrompt = replaceComposerToken(
            prompt,
            activeToken,
            suggestion.value,
        );
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
        if (command === 'skills') {
            setPrompt('$');
            return true;
        }
        if (command === 'mcp') {
            setPrompt('/mcp ');
            return true;
        }
        if (command === 'rollback' || command === 'shell') {
            shouldScrollToBottomRef.current = true;
            onSlashCommand?.(command);
            setPrompt('');
            setSuggestions([]);
            setActiveToken(null);
            setSelectedSuggestionIndex(0);
            return true;
        }
        if (
            commandSuggestions(command, appServerCatalog ?? undefined).some(
                (entry) =>
                    entry.kind === 'command' && entry.commandId === command,
            )
        ) {
            shouldScrollToBottomRef.current = true;
            onSlashCommand?.(command);
            setPrompt('');
            setSuggestions([]);
            setActiveToken(null);
            setSelectedSuggestionIndex(0);
            return true;
        }
        return false;
    };

    const visibleDeltas = useMemo(() => {
        const completedItemIds = new Set(
            detail?.turns.flatMap((turn) =>
                turn.items.map((item) => item.id),
            ) ?? [],
        );
        return Object.entries(liveDeltas).filter(([itemId, delta]) => {
            if (
                delta.threadId !== detail?.id ||
                delta.item.type === 'userMessage'
            ) {
                return false;
            }
            if (completedItemIds.has(itemId)) {
                return false;
            }
            return hasRenderableLiveContent(delta.item, delta.text);
        });
    }, [detail, liveDeltas]);
    const turns = detail?.turns || [];
    const latestTurn = turns.at(-1);
    const latestTurnHasAssistantItems =
        latestTurn?.items.some((item) => item.type !== 'userMessage') ?? false;
    const shouldShowThinking =
        (Boolean(pendingPrompt) ||
            latestTurn?.status === 'inProgress' ||
            sending) &&
        !latestTurnHasAssistantItems &&
        visibleDeltas.length === 0;
    const isActivelyStreaming =
        shouldShowThinking ||
        visibleDeltas.length > 0 ||
        latestTurn?.status === 'inProgress' ||
        sending;

    useEffect(() => {
        console.debug('[chat-debug] ChatView.renderState', {
            threadId: detail?.id ?? null,
            turnIds: turns.map((turn) => turn.id),
            turnItemIds: turns.flatMap((turn) =>
                turn.items.map((item) => item.id),
            ),
            visibleDeltaIds: visibleDeltas.map(([itemId]) => itemId),
            visibleDeltaStreams: visibleDeltas.map(([, delta]) => ({
                itemId: delta.item.id,
                stream: delta.stream,
            })),
            pendingPrompt: pendingPrompt ?? null,
            shouldShowThinking,
        });
    }, [detail?.id, pendingPrompt, shouldShowThinking, turns, visibleDeltas]);

    type MixedItem =
        | { kind: 'turn'; id: string; turn: ThreadTurn; isLatest: boolean }
        | { kind: 'pending'; id: string; prompt: string }
        | { kind: 'thinking'; id: string }
        | { kind: 'liveDeltas'; id: string; deltas: typeof visibleDeltas };

    const mixedData = useMemo<MixedItem[]>(() => {
        const data: MixedItem[] = turns.map((turn, index) => ({
            kind: 'turn',
            id: `turn-${turn.id}`,
            turn,
            isLatest: index === turns.length - 1,
        }));
        if (pendingPrompt) {
            data.push({
                kind: 'pending',
                id: 'pending-prompt',
                prompt: pendingPrompt,
            });
        }
        if (shouldShowThinking) {
            data.push({ kind: 'thinking', id: 'assistant-thinking' });
        }
        if (visibleDeltas.length > 0) {
            data.push({
                kind: 'liveDeltas',
                id: 'live-deltas',
                deltas: visibleDeltas,
            });
        }
        return data;
    }, [turns, pendingPrompt, shouldShowThinking, visibleDeltas]);
    const shouldShowEmptyState = !detailRefreshing && mixedData.length === 0;
    const shouldShowScrollToLatestButton = !atBottom && mixedData.length > 0;

    const triggerLoadOlderTurns = useCallback((source: 'manual' | 'auto') => {
        if (
            !historyHasMore ||
            historyLoadingMore ||
            !turns.length ||
            prependInFlightRef.current
        ) {
            return;
        }
        const now = Date.now();
        if (
            source === 'auto' &&
            (now - lastAutoLoadAtRef.current < AUTO_PRELOAD_COOLDOWN_MS ||
                now < suppressAutoPreloadUntilRef.current)
        ) {
            return;
        }
        const scroller = getScroller();
        prependAnchorTurnIdRef.current = turns[0]?.id ?? null;
        prependScrollMetricsRef.current = scroller
            ? {
                  scrollTop: scroller.scrollTop,
                  scrollHeight: scroller.scrollHeight,
              }
            : null;
        prependInFlightRef.current = true;
        lastAutoLoadAtRef.current = now;
        onLoadOlderTurns?.();
    }, [getScroller, historyHasMore, historyLoadingMore, onLoadOlderTurns, turns]);

    useEffect(() => {
        if (detail?.id) {
            const savedScrollTop = savedScrollTopByThreadRef.current[detail.id];
            if (
                typeof savedScrollTop === 'number' &&
                (savedScrollTop > MIN_SCROLL_TOP_TO_RESTORE_PX || !historyHasMore)
            ) {
                pendingRestoreScrollTopRef.current = Math.max(
                    0,
                    savedScrollTop,
                );
            } else {
                pendingRestoreScrollTopRef.current = null;
            }
            suppressAutoPreloadUntilRef.current =
                Date.now() + AUTO_PRELOAD_SUPPRESS_AFTER_RESTORE_MS;
        }
        setIsNearTop(false);
        wasNearTopRef.current = false;
        lastScrollTopRef.current = null;
        prependInFlightRef.current = false;
        prependAnchorTurnIdRef.current = null;
        prependScrollMetricsRef.current = null;
    }, [detail?.id, historyHasMore]);

    useEffect(() => {
        if (
            !detail?.id ||
            detailRefreshing ||
            turns.length === 0 ||
            mixedData.length === 0
        ) {
            return;
        }
        const scroller = getScroller();
        if (!scroller) {
            return;
        }

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const restoreTop = pendingRestoreScrollTopRef.current;
                const targetTop =
                    typeof restoreTop === 'number'
                        ? restoreTop
                        : Math.max(
                              0,
                              scroller.scrollHeight - scroller.clientHeight - 24,
                          );
                scroller.scrollTo({
                    top: targetTop,
                    behavior: 'auto',
                });
                lastScrollTopRef.current = targetTop;
                pendingRestoreScrollTopRef.current = null;
            });
        });
    }, [detail?.id, detailRefreshing, getScroller, mixedData.length, turns.length]);

    useEffect(() => {
        const scroller = getScroller();
        if (!scroller) {
            return;
        }

        const updateNearTop = () => {
            if (detail?.id) {
                savedScrollTopByThreadRef.current[detail.id] =
                    scroller.scrollTop;
            }
            const previousScrollTop = lastScrollTopRef.current;
            const isMovingUp =
                previousScrollTop === null
                    ? false
                    : scroller.scrollTop < previousScrollTop - 2;
            const nextIsNearTop = scroller.scrollTop <= TOP_PRELOAD_THRESHOLD_PX;
            setIsNearTop(nextIsNearTop);
            if (
                nextIsNearTop &&
                !wasNearTopRef.current &&
                isMovingUp &&
                historyHasMore &&
                !historyLoadingMore
            ) {
                triggerLoadOlderTurns('auto');
            }
            wasNearTopRef.current = nextIsNearTop;
            lastScrollTopRef.current = scroller.scrollTop;
        };

        updateNearTop();
        scroller.addEventListener('scroll', updateNearTop, { passive: true });
        return () => {
            scroller.removeEventListener('scroll', updateNearTop);
        };
    }, [detail?.id, getScroller, historyHasMore, historyLoadingMore, triggerLoadOlderTurns]);

    useEffect(() => {
        if (!prependInFlightRef.current || !prependAnchorTurnIdRef.current) {
            return;
        }
        if (historyLoadingMore) {
            return;
        }
        const scroller = getScroller();
        const previousMetrics = prependScrollMetricsRef.current;
        if (scroller && previousMetrics) {
            requestAnimationFrame(() => {
                const heightDelta =
                    scroller.scrollHeight - previousMetrics.scrollHeight;
                scroller.scrollTop = previousMetrics.scrollTop + heightDelta;
                lastScrollTopRef.current = scroller.scrollTop;
                if (detail?.id) {
                    savedScrollTopByThreadRef.current[detail.id] =
                    scroller.scrollTop;
                }
                suppressAutoPreloadUntilRef.current =
                    Date.now() + AUTO_PRELOAD_SUPPRESS_AFTER_RESTORE_MS;
            });
        } else {
            const anchorId = prependAnchorTurnIdRef.current;
            const anchorIndex = mixedData.findIndex(
                (item) => item.kind === 'turn' && item.turn.id === anchorId,
            );
            if (anchorIndex >= 0) {
                requestAnimationFrame(() => {
                    virtuosoRef.current?.scrollToIndex({
                        index: anchorIndex,
                        align: 'start',
                        behavior: 'auto',
                    });
                    suppressAutoPreloadUntilRef.current =
                        Date.now() + AUTO_PRELOAD_SUPPRESS_AFTER_RESTORE_MS;
                });
            }
        }
        prependInFlightRef.current = false;
        prependAnchorTurnIdRef.current = null;
        prependScrollMetricsRef.current = null;
    }, [getScroller, historyLoadingMore, mixedData]);

    useEffect(() => {
        if (!detail?.id) {
            initialAutoLoadDoneRef.current = false;
            return;
        }
        if (
            !initialAutoLoadDoneRef.current &&
            historyHasMore &&
            turns.length > 0 &&
            turns.length < INITIAL_HISTORY_AUTOLOAD_TURN_COUNT
        ) {
            initialAutoLoadDoneRef.current = true;
            triggerLoadOlderTurns('auto');
            return;
        }
        if (!historyHasMore) {
            initialAutoLoadDoneRef.current = true;
        }
    }, [detail?.id, historyHasMore, triggerLoadOlderTurns, turns.length]);

    return (
        <section className="relative flex h-full min-h-[440px] flex-col overflow-hidden bg-[var(--chat-canvas)] font-['Segoe_UI','PingFang_SC','Microsoft_YaHei','Noto_Sans_SC',sans-serif] xl:min-h-0">
            <div className="flex-1 w-full h-full min-h-0 relative">
                <Virtuoso
                    key={detail?.id || 'empty'}
                    ref={virtuosoRef}
                    atBottomStateChange={setAtBottom}
                    atBottomThreshold={100}
                    startReached={() => {
                        triggerLoadOlderTurns('auto');
                    }}
                    className="h-full w-full custom-scroll"
                    data={mixedData}
                    computeItemKey={(index, item) => item.id}
                    followOutput={(isAtBottom) => {
                        if (shouldScrollToBottomRef.current) {
                            shouldScrollToBottomRef.current = false;
                            return 'smooth';
                        }
                        if (isAtBottom) {
                            return isActivelyStreaming ? 'auto' : 'smooth';
                        }
                        return false;
                    }}
                    initialTopMostItemIndex={{
                        index: 'LAST',
                        align: 'end',
                    }}
                    alignToBottom={false}
                    components={{
                        Header: () =>
                            shouldShowEmptyState ? (
                                <div className="flex h-64 flex-col items-center justify-center space-y-4 px-6 pt-8 text-center opacity-70">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[color:color-mix(in_srgb,var(--chat-card)_92%,transparent)] text-accent shadow-[0_8px_20px_rgba(0,0,0,0.08)]">
                                        <Sparkles size={32} />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-text-primary">
                                            {t.emptyTitle}
                                        </h3>
                                        <p className="mt-2 max-w-md text-sm text-text-secondary">
                                            {t.emptyText}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="mx-auto flex w-full max-w-[880px] justify-center px-6 pb-2 pt-4">
                                    {historyLoadingMore ? (
                                        <div className="rounded-full bg-[color:color-mix(in_srgb,var(--chat-card)_30%,transparent)] px-3 py-1.5 text-[11px] font-medium text-text-secondary">
                                            {language === 'zh'
                                                ? '正在加载更早消息...'
                                                : 'Loading older messages...'}
                                        </div>
                                    ) : historyHasMore && isNearTop ? (
                                        <button
                                            type="button"
                                            onClick={() => triggerLoadOlderTurns('manual')}
                                            disabled={historyLoadingMore}
                                            className="rounded-full bg-transparent px-3 py-1 text-[11px] font-medium text-text-secondary/80 transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-card)_22%,transparent)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {language === 'zh'
                                                ? '继续向上加载更早消息'
                                                : 'Load older messages'}
                                        </button>
                                    ) : (
                                        <div className="h-6" />
                                    )}
                                </div>
                            ),
                        Footer: () => <div className="h-6" />,
                    }}
                    itemContent={(index, item) => {
                        if (item.kind === 'turn') {
                            return (
                                <div className={item.isLatest ? 'pb-2' : ''}>
                                    <TurnItem
                                        turn={item.turn}
                                        isLatest={item.isLatest}
                                        language={language}
                                    />
                                </div>
                            );
                        }
                        if (item.kind === 'pending') {
                            return (
                                <div className="mx-auto flex w-full max-w-[880px] justify-end px-6 pb-6 pt-2">
                                    <div className="max-w-[58%] rounded-[18px] bg-[color:color-mix(in_srgb,var(--chat-card-soft)_58%,transparent)] px-4 py-3 text-left shadow-[0_4px_12px_rgba(0,0,0,0.06)]">
                                        <div className="mb-2 flex items-center justify-end gap-2 text-[11px] font-medium text-text-secondary">
                                            <span>
                                                {language === 'zh'
                                                    ? '你'
                                                    : 'You'}
                                            </span>
                                            <User size={13} />
                                        </div>
                                        <pre className="whitespace-pre-wrap font-sans text-[14px] leading-6 text-text-primary">
                                            {item.prompt}
                                        </pre>
                                    </div>
                                </div>
                            );
                        }
                        if (item.kind === 'thinking') {
                            return (
                                <div className="mx-auto w-full max-w-[880px] px-6 pb-6">
                                    <ThinkingCard language={language} />
                                </div>
                            );
                        }
                        if (item.kind === 'liveDeltas') {
                            return (
                                <div className="mx-auto w-full max-w-[880px] px-6 pb-4">
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        className="flex flex-col w-full"
                                    >
                                        <div className="flex-1 min-w-0 space-y-2">
                                            {item.deltas.map(
                                                ([itemId, delta]) => (
                                                    <div key={itemId}>
                                                        <div className="mb-3 flex items-center gap-1 px-1">
                                                            <span
                                                                className="h-1.5 w-1.5 rounded-full bg-accent animate-bounce"
                                                                style={{
                                                                    animationDelay:
                                                                        '0ms',
                                                                }}
                                                            />
                                                            <span
                                                                className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
                                                                style={{
                                                                    animationDelay:
                                                                        '150ms',
                                                                }}
                                                            />
                                                            <span
                                                                className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
                                                                style={{
                                                                    animationDelay:
                                                                        '300ms',
                                                                }}
                                                            />
                                                            <span className="ml-2 text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                                                                {language ===
                                                                'zh'
                                                                    ? '流式输出'
                                                                    : 'Streaming'}
                                                            </span>
                                                        </div>
                                                        <LiveItemCard
                                                            item={delta.item}
                                                            stream={
                                                                delta.stream
                                                            }
                                                            text={delta.text}
                                                            language={language}
                                                        />
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    </motion.div>
                                </div>
                            );
                        }
                        return null;
                    }}
                />
                <button
                    type="button"
                    onClick={() => {
                        const scroller = document.querySelector<HTMLDivElement>(
                            '.h-full.w-full.custom-scroll',
                        );
                        if (scroller) {
                            scroller.scrollTo({
                                top: scroller.scrollHeight,
                                behavior: 'smooth',
                            });
                        } else {
                            virtuosoRef.current?.scrollToIndex({
                                index: 'LAST',
                                align: 'end',
                                behavior: 'smooth',
                            });
                        }
                    }}
                    className={cn(
                        'absolute bottom-8 right-8 z-20 rounded-full bg-[color:color-mix(in_srgb,var(--chat-card)_92%,transparent)] p-3 text-text-primary shadow-[0_8px_18px_rgba(0,0,0,0.12)] transition-all duration-150',
                        shouldShowScrollToLatestButton
                            ? 'pointer-events-auto opacity-100 scale-100'
                            : 'pointer-events-none opacity-0 scale-95',
                    )}
                    title="滚动到最新"
                    aria-hidden={!shouldShowScrollToLatestButton}
                    tabIndex={shouldShowScrollToLatestButton ? 0 : -1}
                >
                    <ArrowDown size={18} />
                </button>
            </div>

            <div className="relative z-10 shrink-0 bg-gradient-to-t from-[var(--chat-canvas)] via-[var(--chat-canvas)] to-transparent px-6 pb-6 pt-3">
                <form
                    className="group relative mx-auto flex w-full max-w-[880px] flex-col items-center"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (await maybeHandleSlashCommand()) {
                            return;
                        }
                        await handleSubmitPrompt();
                    }}
                >
                    <div className="pointer-events-none absolute inset-0 rounded-[30px] bg-accent/10 opacity-0 blur-2xl transition-opacity group-focus-within:opacity-100" />

                    <div className="relative flex w-full flex-col overflow-hidden rounded-[30px] bg-[color:color-mix(in_srgb,var(--chat-card)_92%,transparent)] p-3 shadow-[0_10px_28px_rgba(0,0,0,0.12)] transition-all">
                        {hasSuggestions && (
                            <div className="mx-2 mt-2 overflow-hidden rounded-2xl bg-[color:color-mix(in_srgb,var(--chat-card)_94%,transparent)] shadow-[0_10px_28px_rgba(0,0,0,0.14)]">
                                <div className="border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-wider text-text-secondary">
                                    {activeToken?.trigger === '/'
                                        ? language === 'zh'
                                            ? '命令'
                                            : 'Commands'
                                        : activeToken?.trigger === '@'
                                          ? language === 'zh'
                                              ? '文件'
                                              : 'Files'
                                          : 'Skills'}
                                </div>
                                <div className="max-h-64 overflow-y-auto py-1">
                                    {suggestions.map((suggestion, index) => (
                                        <button
                                            key={suggestion.key}
                                            type="button"
                                            className={cn(
                                                'w-full px-3 py-2 text-left transition-colors',
                                                index ===
                                                    selectedSuggestionIndex
                                                    ? 'bg-accent/15'
                                                    : 'hover:bg-white/5',
                                            )}
                                            onMouseDown={(event) => {
                                                event.preventDefault();
                                                applySuggestion(suggestion);
                                            }}
                                        >
                                            <div className="text-sm text-text-primary">
                                                {suggestion.label}
                                            </div>
                                            <div className="text-xs text-text-secondary truncate">
                                                {suggestion.detail}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <textarea
                            ref={textareaRef}
                            id="chat-prompt"
                            name="chat-prompt"
                            className="min-h-[124px] max-h-52 flex-1 resize-none border-none bg-transparent px-4 py-4 text-[15px] leading-7 text-text-primary outline-none focus:ring-0"
                            placeholder={t.placeholder}
                            value={prompt}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                const cursor =
                                    event.target.selectionStart ??
                                    event.target.value.length;
                                setActiveToken(
                                    findActiveComposerToken(
                                        event.target.value,
                                        cursor,
                                    ),
                                );
                            }}
                            onClick={(event) => {
                                const target = event.currentTarget;
                                setActiveToken(
                                    findActiveComposerToken(
                                        target.value,
                                        target.selectionStart ??
                                            target.value.length,
                                    ),
                                );
                            }}
                            onSelect={(event) => {
                                const target = event.currentTarget;
                                setActiveToken(
                                    findActiveComposerToken(
                                        target.value,
                                        target.selectionStart ??
                                            target.value.length,
                                    ),
                                );
                            }}
                            onKeyDown={async (event) => {
                                if (hasSuggestions) {
                                    if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        setSelectedSuggestionIndex(
                                            (current) =>
                                                (current + 1) %
                                                suggestions.length,
                                        );
                                        return;
                                    }
                                    if (event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        setSelectedSuggestionIndex(
                                            (current) =>
                                                (current -
                                                    1 +
                                                    suggestions.length) %
                                                suggestions.length,
                                        );
                                        return;
                                    }
                                    if (
                                        event.key === 'Enter' ||
                                        event.key === 'Tab'
                                    ) {
                                        event.preventDefault();
                                        applySuggestion(
                                            suggestions[
                                                selectedSuggestionIndex
                                            ],
                                        );
                                        return;
                                    }
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setSuggestions([]);
                                        setActiveToken(null);
                                        return;
                                    }
                                }
                                if (event.key === 'Enter' && event.ctrlKey) {
                                    event.preventDefault();
                                    if (await maybeHandleSlashCommand()) {
                                        return;
                                    }
                                    await handleSubmitPrompt();
                                }
                            }}
                        />

                        <div className="flex items-center justify-between border-t border-white/5 px-4 pb-2 pt-3">
                            <p className="hidden text-[11px] text-text-secondary sm:block">
                                {t.hint}
                            </p>
                            <div className="ml-auto flex items-center gap-2">
                                {(turns.at(-1)?.status === 'inProgress' ||
                                    sending) && (
                                    <button
                                        type="button"
                                        className="rounded-full bg-red-500/10 px-3 py-2 text-xs text-red-500 transition-all hover:bg-red-500/15"
                                        onClick={onInterrupt}
                                    >
                                        {t.stop}
                                    </button>
                                )}
                                <button
                                    type="submit"
                                    disabled={
                                        !prompt.trim() || !canSend || sending
                                    }
                                    title={t.send}
                                    aria-label={t.send}
                                    className="rounded-full bg-accent p-3 text-white shadow-sm transition-all hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
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
