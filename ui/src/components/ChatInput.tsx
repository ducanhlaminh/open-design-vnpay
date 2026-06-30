/**
 * F-28 — ChatInput
 * Textarea + Send/Stop button.
 * Enter sends, Shift+Enter adds newline.
 * isStreaming=true shows Stop (red square) button instead of Send.
 */
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
