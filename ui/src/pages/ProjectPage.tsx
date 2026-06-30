/**
 * F-40 — ProjectPage
 * 2-col layout: Left (chat panel) + Right (workspace panel).
 * SSE streaming via api.runs.sendMessage.
 */
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ChatToolbar } from '../components/ChatToolbar';
import { ChatInput } from '../components/ChatInput';
import { AssistantTurn } from '../components/AssistantTurn';
import { WorkspacePanel } from '../components/WorkspacePanel';
import { useProjectPageStore } from '../store/projectPageStore';
import { useAppStore } from '../store/appStore';
import { api } from '../api';

export default function ProjectPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const store = useProjectPageStore();
  const { selectedDesignSystemId, selectedSkillId } = useAppStore();

  useEffect(() => {
    if (projectId) store.initProject(projectId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [store.turns.length]);

  const handleSend = async (message: string) => {
    if (!projectId) return;
    store.addUserTurn(message);
    const turnId = store.startAssistantTurn();

    // Get or create a conversation
    let convId: string;
    try {
      const conversations = await api.runs.listConversations(projectId);
      convId = conversations.length > 0
        ? conversations[conversations.length - 1].id
        : (await api.runs.createConversation(projectId)).id;
    } catch {
      const conv = await api.runs.createConversation(projectId);
      convId = conv.id;
    }

    abortRef.current = api.runs.sendMessage(projectId, convId, {
      content: message,
      designSystemId: selectedDesignSystemId ?? undefined,
      skillId: selectedSkillId ?? undefined,
    }, {
      onDelta: (e) => store.appendDelta(turnId, e.text),
      onToolUse: (e) => store.addToolUse(turnId, {
        id: crypto.randomUUID(),
        toolName: e.name,
        input: (e.input as Record<string, unknown>) ?? {},
        status: 'done',
      }),
      onTodo: (e) => store.setTodos(turnId, e.items),
      onArtifact: (e) => store.setArtifact(turnId, {
        identifier: e.identifier,
        title: e.title,
        content: e.html,
        artifactType: e.artifactType ?? 'html',
      }),
      onQuestionForm: (e) => store.showQuestionForm(turnId, {
        id: e.id,
        question: e.title ?? 'Please answer',
        options: e.fields.filter((f) => f.type === 'radio').flatMap((f) => f.options ?? []),
      }),
      onDirectionPicker: (e) => store.showDirectionPicker(turnId, {
        id: crypto.randomUUID(),
        directions: e.directions.map((d) => d.id),
      }),
      onEnd: () => store.finishTurn(turnId),
      onError: (e) => store.setError(e.message),
    });
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    store.reset();
  };

  const isStreaming = store.phase === 'streaming';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Chat panel (35%) */}
      <div style={{
        width: '35%', minWidth: 320, maxWidth: 480,
        display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}>
        <ChatToolbar projectId={projectId ?? ''} />

        {/* Chat history */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {store.turns.map((turn) => (
            turn.role === 'user' ? (
              <div key={turn.id} style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{
                  maxWidth: '80%', padding: '8px 12px',
                  background: 'var(--color-accent)', borderRadius: '10px 10px 2px 10px',
                  color: '#fff', fontSize: 13,
                }}>
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={turn.id} style={{ marginBottom: 12 }}>
                <AssistantTurn
                  turn={turn}
                  onAnswerQuestion={() => { /* TODO: submit answers via SSE */ }}
                  onSelectDirection={() => { /* TODO: submit direction selection */ }}
                />
              </div>
            )
          ))}
          {store.phase === 'error' && (
            <div style={{ color: '#fa5050', fontSize: 12, padding: '8px 0' }}>
              Error: {store.error}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          disabled={isStreaming}
          isStreaming={isStreaming}
        />
      </div>

      {/* Right: Workspace panel (65%) */}
      <WorkspacePanel
        artifact={store.activeArtifact}
        projectId={projectId ?? ''}
      />
    </div>
  );
}
