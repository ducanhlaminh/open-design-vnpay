/**
 * F-27 — ChatToolbar
 * Toolbar at top of chat panel: DS Picker (compact) + Skill Picker + Agent Selector
 * + Import/Transcript utility buttons.
 */
import { DesignSystemPicker } from './DesignSystemPicker';
import { SkillPicker } from './SkillPicker';
import { AgentSelector } from './AgentSelector';
import { useAppStore } from '../store/appStore';

interface ChatToolbarProps {
  projectId: string;
}

export function ChatToolbar({ projectId: _projectId }: ChatToolbarProps) {
  const {
    selectedDesignSystemId,
    selectedSkillId,
    selectedAgentId,
    setSelectedDS,
    setSelectedSkill,
    setSelectedAgent,
  } = useAppStore();

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
      {/* Design System picker (compact) */}
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

      {/* Right side utility buttons */}
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
