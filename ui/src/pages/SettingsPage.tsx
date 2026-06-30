/**
 * F-45 — SettingsPage
 * 9-tab settings: General | Appearance | API Keys | Agents | Connectors | Memory | MCP | Plugins | About
 * Priority tabs fully implemented: General, API Keys, Appearance.
 * Others render a stub with key config.
 */
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/appStore';

type SettingsTab = 'general' | 'appearance' | 'api-keys' | 'agents' | 'connectors' | 'memory' | 'mcp' | 'plugins' | 'about';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'general',    label: 'General',    icon: '⚙️' },
  { id: 'appearance', label: 'Appearance', icon: '🎨' },
  { id: 'api-keys',   label: 'API Keys',   icon: '🔑' },
  { id: 'agents',     label: 'Agents',     icon: '🤖' },
  { id: 'connectors', label: 'Connectors', icon: '🔌' },
  { id: 'memory',     label: 'Memory',     icon: '🧠' },
  { id: 'mcp',        label: 'MCP',        icon: '🔗' },
  { id: 'plugins',    label: 'Plugins',    icon: '🧩' },
  { id: 'about',      label: 'About',      icon: 'ℹ️' },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)', marginBottom: 16, marginTop: 0 }}>
      {children}
    </h2>
  );
}

function FieldRow({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 6 }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-text)',
  fontSize: 13,
  padding: '7px 12px',
  outline: 'none',
  boxSizing: 'border-box',
};

function GeneralTab() {
  const { config } = useAppStore();
  return (
    <div>
      <SectionTitle>General</SectionTitle>
      <FieldRow label="Base URL" hint="URL of the Open Design API server">
        <input style={inputStyle} defaultValue={config?.baseUrl ?? ''} placeholder="http://localhost:1235" readOnly />
      </FieldRow>
      <FieldRow label="Model" hint="Default LLM model for generation">
        <input style={inputStyle} defaultValue={config?.model ?? ''} placeholder="claude-3-5-sonnet-20241022" readOnly />
      </FieldRow>
    </div>
  );
}

function AppearanceTab() {
  const { theme, setTheme } = useAppStore();
  const THEMES = [
    { value: 'dark' as const, label: '🌙 Dark' },
    { value: 'light' as const, label: '☀️ Light' },
    { value: 'system' as const, label: '💻 System' },
  ];
  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <FieldRow label="Theme">
        <div style={{ display: 'flex', gap: 8 }}>
          {THEMES.map((t) => (
            <button
              key={t.value}
              id={`settings-theme-${t.value}`}
              onClick={() => setTheme(t.value)}
              style={{
                padding: '6px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${theme === t.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: theme === t.value ? 'rgba(124,109,250,0.15)' : 'transparent',
                color: theme === t.value ? 'var(--color-accent)' : 'var(--color-text)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </FieldRow>
    </div>
  );
}

function ApiKeysTab() {
  const { config } = useAppStore();
  const providers = Object.entries(config?.apiProtocolConfigs ?? {});

  return (
    <div>
      <SectionTitle>API Keys</SectionTitle>
      {providers.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          No API providers configured. Add keys via the CLI config or server settings.
        </div>
      ) : (
        providers.map(([protocol, cfg]) => (
          <FieldRow key={protocol} label={protocol.charAt(0).toUpperCase() + protocol.slice(1)}>
            <input
              style={inputStyle}
              type="password"
              defaultValue={cfg?.apiKey ? `${cfg.apiKey.slice(0, 6)}${'•'.repeat(10)}` : ''}
              readOnly
              placeholder="Not configured"
            />
          </FieldRow>
        ))
      )}
    </div>
  );
}

function StubTab({ title, icon }: { title: string; icon: string }) {
  return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, marginTop: 6 }}>Configure via server settings or CLI.</div>
    </div>
  );
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as SettingsTab | null;
  const tab: SettingsTab = SETTINGS_TABS.find((t) => t.id === rawTab) ? rawTab! : 'general';

  const setTab = (t: SettingsTab) => setSearchParams({ tab: t });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 200, borderRight: '1px solid var(--color-border)', overflowY: 'auto', flexShrink: 0, background: 'var(--color-surface)' }}>
        <div style={{ padding: '14px 12px 8px', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Settings
        </div>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 14px', textAlign: 'left',
              background: tab === t.id ? 'rgba(124,109,250,0.12)' : 'transparent',
              border: 'none', cursor: 'pointer',
              color: tab === t.id ? 'var(--color-accent)' : 'var(--color-text)',
              fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
              borderLeft: tab === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
            }}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '24px 32px', overflowY: 'auto' }}>
        {tab === 'general' && <GeneralTab />}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'api-keys' && <ApiKeysTab />}
        {tab === 'agents' && <StubTab title="Agents" icon="🤖" />}
        {tab === 'connectors' && <StubTab title="Connectors" icon="🔌" />}
        {tab === 'memory' && <StubTab title="Memory" icon="🧠" />}
        {tab === 'mcp' && <StubTab title="MCP" icon="🔗" />}
        {tab === 'plugins' && <StubTab title="Plugins" icon="🧩" />}
        {tab === 'about' && (
          <div>
            <SectionTitle>About</SectionTitle>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>✦ Open Design</div>
              <div>AI-powered design platform</div>
              <div style={{ marginTop: 12, fontSize: 12 }}>Version: 1.0.0</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
