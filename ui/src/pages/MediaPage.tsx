/**
 * F-42 — MediaPage
 * Surface tabs: Image | Video | Audio
 * Mode switch: Direct | Template (| Hyperframes for video)
 * PromptTemplateGallery for template mode
 * MediaTaskCard grid with 3s auto-refresh
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PromptTemplateGallery } from '../components/PromptTemplateGallery';
import { TemplateArgumentForm } from '../components/TemplateArgumentForm';
import { MediaTaskCard } from '../components/MediaTaskCard';
import type { MediaJobSummary, PromptTemplateSummary } from '../types';

type Surface = 'image' | 'video' | 'audio';
type Mode = 'direct' | 'template';

export default function MediaPage() {
  const [surface, setSurface] = useState<Surface>('image');
  const [mode, setMode] = useState<Mode>('direct');
  const [prompt, setPrompt] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplateSummary | null>(null);
  const [templateArgs, setTemplateArgs] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<MediaJobSummary[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-refresh while any task is pending/processing
  useEffect(() => {
    const hasPending = tasks.some((t) => t.status === 'pending' || t.status === 'processing');
    if (hasPending && !refreshRef.current) {
      refreshRef.current = setInterval(loadTasks, 3000);
    } else if (!hasPending && refreshRef.current) {
      clearInterval(refreshRef.current);
      refreshRef.current = null;
    }
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [tasks]);

  // Load tasks on surface change
  useEffect(() => {
    loadTasks();
    setSelectedTemplate(null);
    setTemplateArgs({});
  }, [surface]);

  const loadTasks = async () => {
    try {
      const resp = await (api.media as any).listTasks?.({ surface }) ?? { items: [] };
      const list = Array.isArray(resp) ? resp : resp.items ?? [];
      setTasks(list);
    } catch {
      // graceful — media list not critical
    }
  };

  const handleGenerate = async () => {
    setError('');
    const finalPrompt = mode === 'template' && selectedTemplate
      ? `Template: ${selectedTemplate.title}`
      : prompt.trim();

    if (!finalPrompt && mode === 'direct') { setError('Enter a prompt first'); return; }

    setGenerating(true);
    try {
      if (surface === 'image') {
        await api.media.generateImage({
          projectId: '',
          prompt: finalPrompt,
          model: selectedTemplate?.model ?? 'gpt-image-2',
          aspect: (selectedTemplate?.aspect ?? '1:1') as '1:1' | '16:9' | '4:3' | '9:16' | '3:4',
        });
      } else if (surface === 'video') {
        await api.media.generateVideo({
          projectId: '',
          prompt: finalPrompt,
          model: (selectedTemplate?.model ?? 'seedance-2.0') as 'seedance-2.0' | 'hyperframes-html',
          aspect: selectedTemplate?.aspect ?? '16:9',
        });
      } else {
        await api.media.generateAudio({
          projectId: '',
          kind: 'speech',
          text: finalPrompt,
          voiceId: 'default',
        });
      }
      await loadTasks();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const SURFACE_TABS: Array<{ id: Surface; label: string }> = [
    { id: 'image', label: '🖼 Image' },
    { id: 'video', label: '🎬 Video' },
    { id: 'audio', label: '🎵 Audio' },
  ];

  const MODE_TABS: Array<{ id: Mode; label: string }> = [
    { id: 'direct', label: 'Direct' },
    { id: 'template', label: 'Template' },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Surface tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', paddingLeft: 16 }}>
        {SURFACE_TABS.map((t) => (
          <button
            key={t.id}
            id={`media-surface-${t.id}`}
            onClick={() => setSurface(t.id)}
            style={{
              padding: '10px 18px', fontSize: 13, border: 'none', cursor: 'pointer',
              background: 'transparent',
              color: surface === t.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              borderBottom: surface === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              fontWeight: surface === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {/* Mode switch */}
        {surface !== 'audio' && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {MODE_TABS.map((m) => (
              <button
                key={m.id}
                id={`media-mode-${m.id}`}
                onClick={() => setMode(m.id)}
                style={{
                  padding: '5px 14px', fontSize: 12, cursor: 'pointer',
                  borderRadius: 6, border: `1px solid ${mode === m.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: mode === m.id ? 'rgba(124,109,250,0.15)' : 'transparent',
                  color: mode === m.id ? 'var(--color-accent)' : 'var(--color-text-muted)',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Template gallery */}
        {mode === 'template' && surface !== 'audio' && (
          <div style={{ marginBottom: 20 }}>
            <PromptTemplateGallery
              surface={surface as 'image' | 'video'}
              selectedId={selectedTemplate?.id}
              onSelect={(t) => {
                setSelectedTemplate(t);
                setTemplateArgs({});
              }}
            />
            {selectedTemplate && (
              <div style={{ marginTop: 16, padding: 16, background: 'var(--color-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
                <TemplateArgumentForm
                  args={(selectedTemplate as any).arguments ?? []}
                  values={templateArgs}
                  onChange={setTemplateArgs}
                />
              </div>
            )}
          </div>
        )}

        {/* Direct prompt input */}
        {(mode === 'direct' || surface === 'audio') && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 6 }}>
              {surface === 'audio' ? 'Text to speak' : 'Prompt'}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                surface === 'image' ? 'A serene Japanese garden at dusk...'
                : surface === 'video' ? 'Time-lapse of a blooming flower...'
                : 'Enter text to convert to speech...'
              }
              rows={3}
              style={{
                width: '100%', resize: 'vertical',
                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                borderRadius: 10, color: 'var(--color-text)', fontSize: 13,
                padding: '10px 12px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
          </div>
        )}

        {/* Error */}
        {error && <div style={{ fontSize: 12, color: '#fa5050', marginBottom: 12 }}>{error}</div>}

        {/* Generate button */}
        <button
          id="media-generate"
          onClick={handleGenerate}
          disabled={generating}
          style={{
            padding: '9px 24px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600,
            background: generating ? 'rgba(124,109,250,0.5)' : 'var(--color-accent)',
            color: '#fff', cursor: generating ? 'wait' : 'pointer',
            marginBottom: 24,
          }}
        >
          {generating ? 'Generating...' : `Generate ${surface.charAt(0).toUpperCase() + surface.slice(1)}`}
        </button>

        {/* Task results grid */}
        {tasks.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Results
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}>
              {tasks.map((task) => (
                <MediaTaskCard key={task.id} task={task} onRefresh={loadTasks} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
