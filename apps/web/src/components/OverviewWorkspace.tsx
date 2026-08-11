import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamViaDaemon } from '../providers/daemon';
import { fetchProjectFiles } from '../providers/registry';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
  saveMessage,
  saveTabs,
} from '../state/projects';
import { appendErrorStatusEvent } from '../runtime/chat-events';
import { randomUUID } from '../utils/uuid';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
  Conversation,
  OpenTabsState,
  ProjectFile,
} from '../types';
import { ChatPane } from './ChatPane';
import { FileWorkspace } from './FileWorkspace';
import { Icon } from './Icon';

const OVERVIEW_PROJECT_ID = 'overview';
const OVERVIEW_GREETING =
  'Tôi đọc được số App/Feature, tiến độ từng workflow, và nội dung output pipeline. ' +
  'Tôi không sửa được dữ liệu pipeline — nhưng có thể xuất báo cáo (HTML/Markdown) vào thư mục của workspace này.';
const OVERVIEW_AGENT_PROMPT = [
  'Bạn đang ở Workspace tổng.',
  'Dùng các API/MCP overview để trả lời về App, Feature, tiến độ từng workflow và output pipeline.',
  'KHÔNG sửa dữ liệu pipeline hay project khác; không POST/PATCH/DELETE.',
  'Được phép GHI FILE BÁO CÁO (HTML, Markdown…) vào đúng thư mục làm việc hiện tại của bạn khi người dùng yêu cầu xuất báo cáo.',
  'Nêu rõ khi dữ liệu chưa có.',
].join('\n');

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  onBack: () => void;
  seedPrompt?: string | null;
  /** A prompt submitted from Home starts an isolated conversation, never reuses history. */
  startNewConversation?: boolean;
}

function initialMessages(): ChatMessage[] {
  return [
    {
      id: 'overview-greeting',
      role: 'assistant',
      content: OVERVIEW_GREETING,
      events: [{ kind: 'text', text: OVERVIEW_GREETING }],
      createdAt: Date.now(),
    },
  ];
}

export function OverviewWorkspace({
  config,
  agents,
  onBack,
  seedPrompt,
  startNewConversation = false,
}: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState(seedPrompt?.trim() || '');
  const abortRef = useRef<AbortController | null>(null);
  const seededRef = useRef(false);
  // Cây thư mục bên phải — nơi agent xuất báo cáo (HTML/MD). Tabs được lưu
  // qua daemon như ProjectView/DS flow để F5 không mất chỗ.
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [tabsState, setTabsState] = useState<OpenTabsState>({ tabs: [], active: null });
  const [openRequest, setOpenRequest] = useState<{ name: string; nonce: number } | null>(null);
  const tabsLoadedRef = useRef(false);

  const refreshFiles = useCallback(async () => {
    const next = await fetchProjectFiles(OVERVIEW_PROJECT_ID).catch(() => [] as ProjectFile[]);
    setFiles((current) => {
      // Agent vừa sinh file mới → tự mở tab cho file đầu tiên chưa từng thấy,
      // để "xuất báo cáo" kết thúc bằng chính bản báo cáo trước mặt người dùng.
      const known = new Set(current.map((file) => file.name));
      const fresh = next.find((file) => file.type !== 'dir' && !known.has(file.name));
      if (fresh && current.length > 0) {
        setOpenRequest({ name: fresh.name, nonce: Date.now() });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshFiles();
    void loadTabs(OVERVIEW_PROJECT_ID).then((stored) => {
      tabsLoadedRef.current = true;
      if (stored.tabs.length > 0) setTabsState(stored);
    });
  }, [refreshFiles]);

  const persistTabsState = useCallback((next: OpenTabsState) => {
    setTabsState(next);
    if (tabsLoadedRef.current) void saveTabs(OVERVIEW_PROJECT_ID, next);
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    const loaded = await listMessages(OVERVIEW_PROJECT_ID, conversationId);
    setMessages(loaded.length > 0 ? loaded : initialMessages());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let existing = await listConversations(OVERVIEW_PROJECT_ID);
      if (cancelled) return;
      let active: Conversation | null = null;
      if (startNewConversation) {
        // Home is an entry point for a fresh question. Reusing the first
        // conversation here leaked a new Home prompt into an old workspace.
        const fresh = await createConversation(OVERVIEW_PROJECT_ID, 'Workspace tổng');
        if (!fresh) {
          if (!cancelled) setError('Không thể tạo workspace mới. Thử lại sau.');
          return;
        }
        existing = [...existing, fresh];
        active = fresh;
      } else if (existing.length === 0) {
        const fresh = await createConversation(OVERVIEW_PROJECT_ID, 'Workspace tổng');
        if (fresh) existing = [fresh];
        active = fresh ?? null;
      }
      if (cancelled) return;
      setConversations(existing);
      active ??= existing[0] ?? null;
      // Nạp lịch sử XONG rồi mới đặt activeConversationId. Effect gieo seed
      // gate bằng id này (send() cũng vậy) — đặt id trước khi listMessages
      // trả về là mở cửa cho seed bắn trên state chào mừng rồi bị
      // loadConversation ghi đè mất tin nhắn vừa gửi.
      if (active) {
        await loadConversation(active.id);
        if (cancelled) return;
      }
      setActiveConversationId(active?.id ?? null);
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [loadConversation, startNewConversation]);

  const send = useCallback(async (
    prompt: string,
    _attachments: ChatAttachment[],
    _commentAttachments: ChatCommentAttachment[],
  ) => {
    const text = prompt.trim();
    if (!text || streaming || !activeConversationId) return;
    if (config.mode !== 'daemon' || !config.agentId) {
      setError('Chọn agent local trước khi đặt câu hỏi.');
      return;
    }
    setError(null);
    setSeed('');
    const startedAt = Date.now();
    const userMessage: ChatMessage = {
      id: randomUUID(), role: 'user', content: text, createdAt: startedAt,
    };
    const agent = agents.find((item) => item.id === config.agentId);
    const assistantMessage: ChatMessage = {
      id: randomUUID(), role: 'assistant', content: '', events: [], createdAt: startedAt,
      startedAt, runStatus: 'running', agentId: config.agentId,
      agentName: agent?.name ?? config.agentId,
    };
    const history = [...messages, userMessage];
    const agentHistory = [...messages, { ...userMessage, content: `${OVERVIEW_AGENT_PROMPT}\n\nCâu hỏi: ${text}` }];
    setMessages([...history, assistantMessage]);
    void saveMessage(OVERVIEW_PROJECT_ID, activeConversationId, userMessage);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let snapshot = assistantMessage;
    const update = (next: ChatMessage, persist = false) => {
      snapshot = next;
      setMessages((current) => current.map((item) => item.id === next.id ? next : item));
      if (persist) void saveMessage(OVERVIEW_PROJECT_ID, activeConversationId, next);
    };
    void streamViaDaemon({
      agentId: config.agentId,
      history: agentHistory,
      signal: controller.signal,
      cancelSignal: controller.signal,
      projectId: OVERVIEW_PROJECT_ID,
      conversationId: activeConversationId,
      assistantMessageId: assistantMessage.id,
      clientRequestId: randomUUID(),
      skillId: null,
      designSystemId: null,
      attachments: [],
      commentAttachments: [],
      model: config.agentModels?.[config.agentId]?.model ?? null,
      reasoning: config.agentModels?.[config.agentId]?.reasoning ?? null,
      handlers: {
        onDelta: (delta) => update({ ...snapshot, content: snapshot.content + delta, events: [...(snapshot.events ?? []), { kind: 'text', text: delta }] }),
        onAgentEvent: (event: AgentEvent) => update({ ...snapshot, events: [...(snapshot.events ?? []), event] }),
        onDone: () => {
          update({ ...snapshot, endedAt: Date.now(), runStatus: snapshot.runStatus === 'failed' ? 'failed' : 'succeeded' }, true);
          setStreaming(false);
          abortRef.current = null;
          // Agent có thể vừa xuất báo cáo vào thư mục workspace — làm mới cây.
          void refreshFiles();
        },
        onError: (cause) => {
          const message = cause.message;
          setError(message);
          update({ ...appendErrorStatusEvent(snapshot, message), endedAt: Date.now(), runStatus: 'failed' }, true);
          setStreaming(false);
          abortRef.current = null;
        },
      },
      onRunCreated: (runId) => update({ ...snapshot, runId, runStatus: 'queued' }, true),
      onRunStatus: (runStatus) => update({ ...snapshot, runStatus }, ['succeeded', 'failed', 'canceled'].includes(runStatus)),
    });
  }, [activeConversationId, agents, config, messages, refreshFiles, streaming]);

  useEffect(() => {
    if (!seed || seededRef.current || !activeConversationId || messages.length > 1) return;
    seededRef.current = true;
    void send(seed, [], []);
  }, [activeConversationId, messages.length, seed, send]);

  const selectConversation = useCallback(async (id: string) => {
    // Cùng thứ tự với effect khởi tạo: nạp lịch sử xong mới trỏ active id,
    // tránh gửi tin vào hội thoại mới khi màn còn hiện tin của hội thoại cũ.
    await loadConversation(id);
    setActiveConversationId(id);
  }, [loadConversation]);
  const newConversation = useCallback(async () => {
    const fresh = await createConversation(OVERVIEW_PROJECT_ID, 'Workspace tổng');
    if (!fresh) return;
    setConversations((current) => [...current, fresh]);
    setActiveConversationId(fresh.id);
    setMessages(initialMessages());
  }, []);
  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  // Chip câu hỏi gợi ý — chỉ hiện khi hội thoại còn trắng (mỗi chip là một
  // lượt hỏi thật, bấm là gửi luôn).
  const showSuggestions = !streaming && messages.length <= 1;
  const suggestions = [
    'Có bao nhiêu App và Feature? Liệt kê theo App.',
    'Feature nào đang chạy dở? Tới bước nào rồi?',
    'Xuất báo cáo tiến độ toàn bộ App ra file HTML.',
  ];

  return (
    <div className="app overview-workspace">
      <header className="overview-workspace__header">
        <button type="button" className="icon-only" onClick={onBack} aria-label="Back">
          <Icon name="arrow-left" />
        </button>
        <span className="overview-workspace__badge" aria-hidden>
          <Icon name="kanban" size={16} />
        </span>
        <div className="overview-workspace__title">
          <strong>Workspace tổng</strong>
          <span>Hỏi tiến độ App / Feature trên toàn bộ pipeline</span>
        </div>
        <span className="overview-workspace__readonly">Đọc pipeline · ghi báo cáo tại chỗ</span>
      </header>
      <div className="overview-workspace__body">
        <aside className="overview-workspace__chat">
          <ChatPane
            messages={messages}
            streaming={streaming}
            error={error}
            projectId={OVERVIEW_PROJECT_ID}
            projectFiles={files}
            composerPlaceholder="Hỏi tiến độ App / Feature… (vd: Feature nào đang chạy dở?)"
            onEnsureProject={async () => OVERVIEW_PROJECT_ID}
            onSend={send}
            onStop={stop}
            conversations={conversations}
            activeConversationId={activeConversationId}
            onSelectConversation={(id) => void selectConversation(id)}
            onDeleteConversation={() => {}}
            onNewConversation={() => void newConversation()}
          />
          {showSuggestions ? (
            <div className="overview-workspace__suggestions" aria-label="Câu hỏi gợi ý">
              {suggestions.map((question) => (
                <button
                  key={question}
                  type="button"
                  className="overview-workspace__suggestion"
                  onClick={() => void send(question, [], [])}
                >
                  {question}
                </button>
              ))}
            </div>
          ) : null}
        </aside>
        <main className="overview-workspace__files">
          <FileWorkspace
            projectId={OVERVIEW_PROJECT_ID}
            projectKind="other"
            files={files}
            liveArtifacts={[]}
            onRefreshFiles={refreshFiles}
            isDeck={false}
            streaming={streaming}
            openRequest={openRequest}
            tabsState={tabsState}
            onTabsStateChange={persistTabsState}
          />
        </main>
      </div>
    </div>
  );
}
