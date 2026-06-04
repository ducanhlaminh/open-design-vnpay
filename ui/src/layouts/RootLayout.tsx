import { Outlet, NavLink } from 'react-router-dom';
import {
  FolderOpen,
  Layers,
  BookOpen,
  Clock,
  Image,
  Settings,
} from 'lucide-react';

const NAV = [
  { to: '/', icon: FolderOpen, label: 'Projects', end: true },
  { to: '/design-systems', icon: Layers, label: 'Design Systems' },
  { to: '/skills', icon: BookOpen, label: 'Skills' },
  { to: '/routines', icon: Clock, label: 'Routines' },
  { to: '/media', icon: Image, label: 'Media' },
];

export function RootLayout() {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <nav
        style={{
          width: 220,
          flexShrink: 0,
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 8px',
          gap: 4,
        }}
      >
        <div style={{ padding: '8px 12px 16px', fontWeight: 700, fontSize: 15, color: 'var(--color-accent)' }}>
          Open Design
        </div>

        {NAV.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 13,
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              background: isActive ? 'var(--color-border)' : 'transparent',
              transition: 'background 0.15s',
            })}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}

        {/* Settings at bottom */}
        <div style={{ marginTop: 'auto' }}>
          <NavLink
            to="/settings"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 13,
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              background: isActive ? 'var(--color-border)' : 'transparent',
            })}
          >
            <Settings size={16} />
            Settings
          </NavLink>
        </div>
      </nav>

      {/* Main */}
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}
