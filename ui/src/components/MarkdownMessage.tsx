/**
 * F-14 — MarkdownMessage
 * Renders streaming markdown from chat assistant.
 * Shows animated cursor while isStreaming=true.
 * Uses shared simpleMarkdown parser — does NOT fetch URL (renders from prop).
 */
import { simpleMarkdown } from '../utils/markdown';

interface MarkdownMessageProps {
  text: string;
  isStreaming?: boolean;
}

export function MarkdownMessage({ text, isStreaming = false }: MarkdownMessageProps) {
  const html = simpleMarkdown(text);

  return (
    <div
      className="markdown-message"
      style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--color-text)' }}
    >
      <span
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {isStreaming && (
        <span
          className="streaming-cursor"
          style={{
            display: 'inline-block',
            width: 2,
            height: '1em',
            background: 'var(--color-accent)',
            marginLeft: 2,
            verticalAlign: 'middle',
          }}
        />
      )}
    </div>
  );
}
