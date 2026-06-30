# 06 — ProjectPage & Chat Panel

> Trang chính khi user đang làm việc với 1 project.  
> Tích hợp: DS Picker trong toolbar, ArtifactViewer, FileWorkspace, SSE chat.

---

## Layout

```
ProjectPage (2-col hoặc 3-col)
├── [Left] ChatPanel (1/3 width)
│   ├── ChatToolbar (DS Picker + Skill Picker + Agent selector)
│   ├── ChatHistory (message list)
│   │   ├── UserMessage
│   │   ├── AssistantTurn
│   │   │   ├── DeltaStream (streaming text)
│   │   │   ├── TodoCard (if todo event)
│   │   │   ├── QuestionForm (if question_form event)
│   │   │   └── DirectionPicker (if direction_picker event)
│   │   └── ToolUseCard (if tool_use event)
│   └── ChatInput
│       ├── Textarea (multiline, Shift+Enter)
│       ├── FileAttachBtn
│       └── SendBtn (or Stop)
│
└── [Right] WorkspacePanel (2/3 width)
    ├── WorkspaceTabs (Preview | Files | Transcript)
    ├── [Preview] ArtifactViewer (existing T31)
    ├── [Files] FileWorkspace (T32 — TODO)
    └── [Transcript] TranscriptView
```

---

## State machine (useProjectPageStore hoặc local state)

```typescript
type PagePhase =
  | 'idle'          // chờ user input
  | 'streaming'     // đang nhận SSE events
  | 'question'      // hiển thị QuestionForm
  | 'direction'     // hiển thị DirectionPicker
  | 'done'          // run hoàn thành
  | 'error';

interface ProjectPageState {
  phase: PagePhase;
  messages: ChatMessage[];
  currentArtifact: Artifact | null;
  currentTodos: TodoItem[];
  currentStream: string;      // accumulated delta text
  questionForm: QuestionFormEvent | null;
  directionEvent: DirectionPickerEvent | null;
  activeFileId: string | null;
  selectedDsId: string | null;
  selectedSkillId: string | null;
  selectedAgentId: string | null;
  isStreaming: boolean;
  runId: string | null;
}
```

---

## ChatToolbar

```tsx
function ChatToolbar({ projectId, state, dispatch }: Props) {
  return (
    <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', alignItems: 'center' }}>
      {/* Design System picker */}
      <DesignSystemPicker
        compact
        selectedId={state.selectedDsId}
        onSelect={id => dispatch({ type: 'SET_DS', id })}
      />

      {/* Skill picker */}
      <SkillPicker
        compact
        selectedId={state.selectedSkillId}
        onSelect={id => dispatch({ type: 'SET_SKILL', id })}
      />

      {/* Agent selector */}
      <AgentSelector
        selectedId={state.selectedAgentId}
        onSelect={id => dispatch({ type: 'SET_AGENT', id })}
      />

      {/* Right: Import + Export */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
        <button onClick={() => /* open ImportDialog */} title="Import">📂</button>
        <button onClick={() => /* export transcript */} title="Transcript">📄</button>
      </div>
    </div>
  );
}
```

---

## ChatInput + SSE Run loop

```tsx
function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSend(text.trim());
      setText('');
    }
  };

  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid var(--color-border)' }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe what you want to design... (Enter to send, Shift+Enter new line)"
        disabled={disabled}
        rows={3}
        style={{ width: '100%', resize: 'none', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 10, color: 'var(--color-text)', fontSize: 13, padding: '10px 12px' }}
      />
      <button onClick={() => { onSend(text); setText(''); }} disabled={disabled || !text.trim()}>
        {disabled ? 'Stop ■' : 'Send →'}
      </button>
    </div>
  );
}
```

---

## SSE Run integration

```tsx
async function handleSend(message: string) {
  dispatch({ type: 'START_STREAMING' });
  addUserMessage(message);

  try {
    await api.runs.sendMessage(
      { projectId, message, designSystemId: state.selectedDsId, skillId: state.selectedSkillId },
      {
        onDelta: (e) => dispatch({ type: 'APPEND_DELTA', text: e.text }),
        onToolUse: (e) => dispatch({ type: 'ADD_TOOL_USE', event: e }),
        onTodo: (e) => dispatch({ type: 'SET_TODOS', items: e.items }),
        onArtifact: (e) => dispatch({ type: 'SET_ARTIFACT', artifact: e }),
        onFileOp: (e) => dispatch({ type: 'FILE_OP', event: e }),
        onQuestionForm: (e) => dispatch({ type: 'SHOW_QUESTION', form: e }),
        onDirectionPicker: (e) => dispatch({ type: 'SHOW_DIRECTION', event: e }),
        onEnd: (e) => dispatch({ type: 'DONE', usage: e.usage }),
        onError: (e) => dispatch({ type: 'ERROR', error: e.error }),
      },
    );
  } catch (err) {
    dispatch({ type: 'ERROR', error: String(err) });
  }
}
```

---

## AssistantTurn component

```tsx
function AssistantTurn({ turn }: { turn: AssistantTurnData }) {
  return (
    <div>
      {/* Tool use chips */}
      {turn.toolUses.map(t => <ToolUseCard key={t.id} event={t} />)}

      {/* Todo progress */}
      {turn.todos.length > 0 && <TodoCard items={turn.todos} isStreaming={turn.isStreaming} />}

      {/* Delta text (streaming or complete) */}
      {turn.text && <MarkdownMessage text={turn.text} isStreaming={turn.isStreaming} />}

      {/* Question form */}
      {turn.questionForm && (
        <QuestionForm
          form={turn.questionForm}
          onSubmit={answers => handleQuestionAnswer(answers)}
          onSkip={() => handleQuestionSkip()}
          disabled={!turn.isStreaming}
        />
      )}

      {/* Direction picker */}
      {turn.directionEvent && (
        <DirectionPicker
          directions={turn.directionEvent.directions}
          onSelect={id => handleDirectionSelect(id)}
          disabled={!turn.isStreaming}
        />
      )}
    </div>
  );
}
```

---

## WorkspacePanel

```tsx
function WorkspacePanel({ artifact, projectId, files }: Props) {
  const [tab, setTab] = useState<'preview' | 'files' | 'transcript'>('preview');

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)' }}>
        {(['preview', 'files', 'transcript'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', fontSize: 12, border: 'none', cursor: 'pointer',
            background: tab === t ? 'var(--color-surface)' : 'transparent',
            borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
            color: tab === t ? 'var(--color-text)' : 'var(--color-text-muted)',
          }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'preview' && artifact && (
          <ArtifactViewer artifact={artifact} projectId={projectId} />
        )}
        {tab === 'files' && (
          <FileWorkspace projectId={projectId} files={files} />
          // T32 — TODO: implement CodeMirror editor
        )}
        {tab === 'transcript' && <TranscriptView projectId={projectId} />}
      </div>
    </div>
  );
}
```

---

## Files summary

| File | Hành động |
|------|----------|
| `pages/ProjectPage.tsx` | **IMPLEMENT** (T40 — core) |
| `components/ChatToolbar.tsx` | **TẠO MỚI** |
| `components/ChatInput.tsx` | **TẠO MỚI** |
| `components/AssistantTurn.tsx` | **TẠO MỚI** |
| `components/ToolUseCard.tsx` | **TẠO MỚI** |
| `components/MarkdownMessage.tsx` | **TẠO MỚI** |
| `components/WorkspacePanel.tsx` | **TẠO MỚI** |
| `components/SkillPicker.tsx` | **TẠO MỚI** (similar to DSPicker) |
| `components/AgentSelector.tsx` | **TẠO MỚI** |
| `components/FileWorkspace.tsx` | **TẠO MỚI** (T32) — CodeMirror |
| `components/TranscriptView.tsx` | **TẠO MỚI** |
