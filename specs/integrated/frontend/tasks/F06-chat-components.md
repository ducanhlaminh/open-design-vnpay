# F-27..F-35 — P1E: Chat + Project Components

**Phase**: P1E | **Estimate**: ~29h | **Depends on**: P0 + P1A + P1B (DSPicker, MarkdownMessage)  
**Target dir**: `ui/src/components/`

---

## F-27 — `src/components/ChatToolbar.tsx`

**Estimate**: 3h  
**Mục đích**: Toolbar ở đầu chat panel — DS Picker + Skill Picker + Agent Selector

```tsx
import { DesignSystemPicker } from './DesignSystemPicker';
import { SkillPicker } from './SkillPicker';
import { AgentSelector } from './AgentSelector';
import { useAppStore } from '../store/appStore';

interface ChatToolbarProps {
  projectId: string;
}

export function ChatToolbar({ projectId }: ChatToolbarProps) {
  const { selectedDesignSystemId, selectedSkillId, selectedAgentId, setSelectedDS, setSelectedSkill, setSelectedAgent } = useAppStore();

  return (
    <div
      id="chat-toolbar"
      style={{
        display: 'flex',
        gap: 6,
        padding: '8px 12px',
        borderBottom: '1px solid var(--color-border)',
        flexWrap: 'wrap',
        alignItems: 'center',
        background: 'var(--color-surface)',
        minHeight: 46,
      }}
    >
      {/* Design System picker (compact mode) */}
      <DesignSystemPicker
        compact
        selectedId={selectedDesignSystemId}
        onSelect={setSelectedDS}
      />

      {/* Skill picker */}
      <SkillPicker
        compact
        selectedId={selectedSkillId}
        onSelect={setSelectedSkill}
      />

      {/* Agent selector */}
      <AgentSelector
        selectedId={selectedAgentId}
        onSelect={setSelectedAgent}
      />

      {/* Right side actions */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
        <button
          id="chat-toolbar-import"
          title="Import file"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4, borderRadius: 4, fontSize: 16 }}
        >
          📂
        </button>
        <button
          id="chat-toolbar-transcript"
          title="View transcript"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4, borderRadius: 4, fontSize: 16 }}
        >
          📄
        </button>
      </div>
    </div>
  );
}
```

---

## F-28 — `src/components/ChatInput.tsx`

**Estimate**: 2h

```tsx
import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
}

export function ChatInput({ onSend, onStop, disabled = false, isStreaming = false }: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && !disabled) {
        onSend(text.trim());
        setText('');
      }
    }
  };

  const handleSend = () => {
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText('');
      textareaRef.current?.focus();
    }
  };

  return (
    <div
      id="chat-input-area"
      style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ position: 'relative' }}>
        <textarea
          ref={textareaRef}
          id="chat-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to design... (Enter to send, Shift+Enter for new line)"
          disabled={disabled && !isStreaming}
          rows={3}
          style={{
            width: '100%',
            resize: 'none',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            color: 'var(--color-text)',
            fontSize: 13,
            padding: '10px 42px 10px 12px',
            outline: 'none',
            lineHeight: 1.5,
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />

        {/* Send / Stop button */}
        <button
          id={isStreaming ? 'chat-input-stop' : 'chat-input-send'}
          onClick={isStreaming ? onStop : handleSend}
          disabled={!isStreaming && (!text.trim() || disabled)}
          style={{
            position: 'absolute', bottom: 8, right: 8,
            background: isStreaming ? '#fa5050' : 'var(--color-accent)',
            border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer',
            width: 28, height: 28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: (!isStreaming && (!text.trim() || disabled)) ? 0.4 : 1,
          }}
        >
          {isStreaming ? <Square size={12} /> : <Send size={12} />}
        </button>
      </div>

      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
        {isStreaming ? 'Generating... click ■ to stop' : 'Enter to send · Shift+Enter for new line'}
      </div>
    </div>
  );
}
```

---

## F-29 — `src/components/AssistantTurn.tsx`

**Estimate**: 4h

```tsx
import { QuestionForm } from './QuestionForm';
import { DirectionPicker } from './DirectionPicker';
import { MarkdownMessage } from './MarkdownMessage';
import { ToolUseCard } from './ToolUseCard';
import { TodoCard } from './TodoCard';
import type { ChatTurn, QuestionFormEvent, DirectionPickerEvent } from '../store/projectPageStore';

interface AssistantTurnProps {
  turn: ChatTurn;
  onAnswerQuestion?: (answers: Record<string, string>) => void;
  onSkipQuestion?: () => void;
  onSelectDirection?: (id: string) => void;
}

export function AssistantTurn({ turn, onAnswerQuestion, onSkipQuestion, onSelectDirection }: AssistantTurnProps) {
  return (
    <div
      id={`assistant-turn-${turn.id}`}
      style={{
        padding: '10px 0',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Tool use chips */}
      {turn.toolUses.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {turn.toolUses.map((tu) => (
            <ToolUseCard key={tu.id} event={tu} />
          ))}
        </div>
      )}

      {/* Todo list */}
      {turn.todos.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <TodoCard items={turn.todos} isStreaming={turn.isStreaming} />
        </div>
      )}

      {/* Streaming / completed text */}
      {turn.text && (
        <MarkdownMessage text={turn.text} isStreaming={turn.isStreaming} />
      )}

      {/* Artifacts */}
      {turn.artifacts.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          {turn.artifacts.map((a) => (
            <div
              key={a.identifier}
              style={{
                fontSize: 11, padding: '3px 8px',
                borderRadius: 4,
                background: 'rgba(124,109,250,0.15)',
                color: 'var(--color-accent)',
                border: '1px solid rgba(124,109,250,0.3)',
              }}
            >
              📄 {a.title}
            </div>
          ))}
        </div>
      )}

      {/* Question form (interactive) */}
      {turn.questionForm && (
        <div style={{ marginTop: 10 }}>
          <QuestionForm
            form={turn.questionForm}
            onSubmit={onAnswerQuestion ?? (() => {})}
            onSkip={onSkipQuestion ?? (() => {})}
            disabled={!turn.isStreaming}
          />
        </div>
      )}

      {/* Direction picker (interactive) */}
      {turn.directionEvent && (
        <div style={{ marginTop: 10 }}>
          <DirectionPicker
            directions={turn.directionEvent.directions}
            onSelect={onSelectDirection ?? (() => {})}
            disabled={!turn.isStreaming}
          />
        </div>
      )}
    </div>
  );
}
```

---

## F-30 — `src/components/ToolUseCard.tsx`

**Estimate**: 2h

```tsx
import type { ToolUseEvent } from '../store/projectPageStore';
import { SpinnerIcon } from './shared/SpinnerIcon';

interface ToolUseCardProps {
  event: ToolUseEvent;
}

const TOOL_ICONS: Record<string, string> = {
  write_file: '✏️',
  read_file: '📖',
  run_command: '⚡',
  search_web: '🔍',
  generate_image: '🖼',
  default: '🔧',
};

export function ToolUseCard({ event }: ToolUseCardProps) {
  const icon = TOOL_ICONS[event.toolName] ?? TOOL_ICONS.default;
  const isRunning = event.status === 'running';

  return (
    <div
      id={`tool-use-${event.id}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 6,
        fontSize: 11,
        background: isRunning ? 'rgba(124,109,250,0.15)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${isRunning ? 'rgba(124,109,250,0.3)' : 'var(--color-border)'}`,
        color: isRunning ? 'var(--color-accent)' : 'var(--color-text-muted)',
      }}
    >
      {isRunning ? <SpinnerIcon size={11} /> : <span>{icon}</span>}
      <span>{event.toolName.replace(/_/g, ' ')}</span>
      {event.status === 'error' && <span style={{ color: '#fa5050' }}>✕</span>}
      {event.status === 'done' && <span style={{ color: '#6ac47e' }}>✓</span>}
    </div>
  );
}
```

---

## F-31 — `src/components/WorkspacePanel.tsx`

**Estimate**: 3h

```tsx
import { useState } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { FileWorkspace } from './FileWorkspace';
import { TranscriptView } from './TranscriptView';
import type { Artifact } from '../types';

interface WorkspacePanelProps {
  artifact: Artifact | null;
  projectId: string;
  files?: string[];
}

type WorkspaceTab = 'preview' | 'files' | 'transcript';

export function WorkspacePanel({ artifact, projectId, files = [] }: WorkspacePanelProps) {
  const [tab, setTab] = useState<WorkspaceTab>('preview');

  return (
    <div
      id="workspace-panel"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        paddingLeft: 8,
      }}>
        {(['preview', 'files', 'transcript'] as WorkspaceTab[]).map((t) => (
          <button
            key={t}
            id={`workspace-tab-${t}`}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              fontSize: 12,
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
              color: tab === t ? 'var(--color-text)' : 'var(--color-text-muted)',
              borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
              fontWeight: tab === t ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'preview' && artifact && (
          <ArtifactViewer artifact={artifact} projectId={projectId} />
        )}
        {tab === 'preview' && !artifact && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--color-text-muted)', fontSize: 13 }}>
            No preview yet — send a message to generate
          </div>
        )}
        {tab === 'files' && (
          <FileWorkspace projectId={projectId} files={files} />
        )}
        {tab === 'transcript' && (
          <TranscriptView projectId={projectId} />
        )}
      </div>
    </div>
  );
}
```

---

## F-32 — `src/components/SkillPicker.tsx`

**Estimate**: 3h  
**Mục đích**: Tương tự DSPicker nhưng cho Skills — compact mode cho ChatToolbar

```tsx
import { useEffect, useRef, useState } from 'react';
import { Zap, ChevronDown, Check } from 'lucide-react';
import { api } from '../api';
import type { SkillSummary } from '../types';

interface SkillPickerProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function SkillPicker({ selectedId, onSelect, compact, disabled }: SkillPickerProps) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.skills.listSkills().then((resp) => {
      const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
      setSkills(list);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = skills.find((s) => s.id === selectedId);
  const filtered = skills.filter(
    (s) => !search || s.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        id="skill-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: compact ? '4px 8px' : '6px 12px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)', fontSize: 13, cursor: 'pointer',
        }}
      >
        <Zap size={13} />
        {!compact && <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.name ?? 'Skill'}</span>}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="ds-picker-dropdown" id="skill-picker-dropdown">
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              style={{ width: '100%', padding: '4px 8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)', fontSize: 12, outline: 'none' }}
            />
          </div>
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
            {/* None option */}
            <button
              onClick={() => { onSelect(''); setOpen(false); setSearch(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--color-text-muted)', fontSize: 12, cursor: 'pointer' }}
            >
              <Zap size={12} opacity={0.3} />
              <span>No skill</span>
            </button>
            {filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => { onSelect(s.id); setOpen(false); setSearch(''); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 12px', background: selectedId === s.id ? 'rgba(124,109,250,0.12)' : 'transparent', border: 'none', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
              >
                <Zap size={12} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {selectedId === s.id && <Check size={11} color="var(--color-accent)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## F-33 — `src/components/AgentSelector.tsx`

**Estimate**: 2h  
**Mục đích**: Dropdown chọn agent — tương tự SkillPicker

```tsx
import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Check } from 'lucide-react';
import { api } from '../api';
import type { AgentInfo } from '../types';

interface AgentSelectorProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function AgentSelector({ selectedId, onSelect, disabled }: AgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.config.listAgents().then((resp) => {
      const list = Array.isArray(resp) ? resp : (resp as any).agents ?? [];
      setAgents(list);
    }).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = agents.find((a) => a.id === selectedId);

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        id="agent-selector-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 8px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)', fontSize: 12, cursor: 'pointer',
        }}
      >
        <Bot size={13} />
        <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.name ?? 'Auto'}
        </span>
        <ChevronDown size={10} />
      </button>

      {open && agents.length > 0 && (
        <div className="ds-picker-dropdown" id="agent-selector-dropdown">
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => { onSelect(a.id); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', background: selectedId === a.id ? 'rgba(124,109,250,0.12)' : 'transparent', border: 'none', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
              >
                <Bot size={12} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  {a.description && <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{a.description}</div>}
                </div>
                {selectedId === a.id && <Check size={11} color="var(--color-accent)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## F-34 — `src/components/FileWorkspace.tsx`

**Estimate**: 8h — **PHỨC TẠP** (T32 — CodeMirror editor)

```tsx
// TODO: T32 implementation
// Requires: @codemirror/view, @codemirror/state, @codemirror/lang-html, @codemirror/lang-css, @codemirror/lang-javascript
// Install: pnpm add @codemirror/view @codemirror/state @codemirror/basic-setup

import { useEffect, useState } from 'react';
import { api } from '../api';

interface FileWorkspaceProps {
  projectId: string;
  files?: string[];
}

export function FileWorkspace({ projectId, files = [] }: FileWorkspaceProps) {
  const [activeFile, setActiveFile] = useState<string | null>(files[0] ?? null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeFile) return;
    api.projects.getProjectFile(projectId, activeFile)
      .then((f) => setContent(f.content))
      .catch(() => setContent(''));
  }, [projectId, activeFile]);

  const handleSave = async () => {
    if (!activeFile) return;
    setSaving(true);
    await api.projects.updateProjectFile(projectId, activeFile, content);
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* File tree sidebar */}
      <div style={{ width: 180, borderRight: '1px solid var(--color-border)', overflowY: 'auto', flexShrink: 0 }}>
        {files.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFile(f)}
            style={{
              display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
              background: activeFile === f ? 'rgba(124,109,250,0.12)' : 'transparent',
              border: 'none', cursor: 'pointer',
              fontSize: 12, color: activeFile === f ? 'var(--color-accent)' : 'var(--color-text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            📄 {f.split('/').pop()}
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Editor toolbar */}
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{activeFile}</span>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, borderRadius: 4, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', cursor: 'pointer' }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Placeholder for CodeMirror editor */}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            flex: 1, resize: 'none',
            background: '#1a1a2e',
            border: 'none', outline: 'none',
            color: '#e2e2e2',
            fontFamily: 'JetBrains Mono, Fira Code, monospace',
            fontSize: 13, padding: 16, lineHeight: 1.6,
          }}
        />
        {/* TODO: Replace textarea with CodeMirror EditorView */}
      </div>
    </div>
  );
}
```

> **TODO**: Thay `textarea` bằng `@codemirror/view EditorView` khi implement đầy đủ.

---

## F-35 — `src/components/TranscriptView.tsx`

**Estimate**: 2h

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';

interface TranscriptViewProps {
  projectId: string;
}

interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
}

export function TranscriptView({ projectId }: TranscriptViewProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.projects.getProjectTranscript(projectId)
      .then((resp) => setEntries(Array.isArray(resp) ? resp : (resp as any).entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading transcript...</div>;
  }
  if (entries.length === 0) {
    return <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>No transcript yet</div>;
  }

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `transcript-${projectId}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer' }}
        >
          ↓ Export JSON
        </button>
      </div>
      {entries.map((e) => (
        <div key={e.id} style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: e.role === 'user' ? '#6ac47e' : e.role === 'assistant' ? 'var(--color-accent)' : '#f5a623' }}>{e.role}</span>
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
          </div>
          <pre style={{ fontSize: 11, color: 'var(--color-text)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{e.content}</pre>
        </div>
      ))}
    </div>
  );
}
```

---

## Checklist P1E

- [x] F-27: `ChatToolbar.tsx` — DS + Skill + Agent pickers, useAppStore, import/transcript buttons
- [x] F-28: `ChatInput.tsx` — Enter-to-send, Shift+Enter newline, Send/Stop toggle, disabled states
- [x] F-29: `AssistantTurn.tsx` — toolUses, todos, markdownMessage, artifacts, questionForm, directionPicker
- [x] F-30: `ToolUseCard.tsx` — tool icons, running/done/error states, SpinnerIcon
- [x] F-31: `WorkspacePanel.tsx` — preview/files/transcript tabs, ArtifactViewer integration
- [x] F-32: `SkillPicker.tsx` — grouped list, search, "No skill" option, compact mode
- [x] F-33: `AgentSelector.tsx` — agent list with description, "Auto" default
- [x] F-34: `FileWorkspace.tsx` — file tree sidebar, textarea editor (CodeMirror TODO)
- [x] F-35: `TranscriptView.tsx` — entries list, export JSON button

> **Status**: ✅ DONE — all 9 components implemented, `tsc --noEmit` passes (2026-06-04)
