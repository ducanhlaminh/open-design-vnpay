/**
 * F-41 — DesignSystemsPage
 * Category pills, search, DSCard grid, DSDetailDrawer, Import button.
 */
import { useState, useEffect } from 'react';
import { useDesignSystemStore } from '../store/designSystemStore';
import { useAppStore } from '../store/appStore';
import { DSCard } from '../components/DSCard';
import { DSDetailDrawer } from '../components/DSDetailDrawer';
import { ImportDialog } from '../components/ImportDialog';
import { useNavigate } from 'react-router-dom';

export default function DesignSystemsPage() {
  const navigate = useNavigate();
  const { catalog, categories, loading, fetchCatalog } = useDesignSystemStore();
  const { selectedDesignSystemId, setSelectedDS } = useAppStore();
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  const filtered = catalog
    .filter((ds) => category === 'all' || ds.category === category)
    .filter((ds) => !search || ds.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', margin: 0, flex: 1 }}>
          Design Systems <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-muted)' }}>({catalog.length})</span>
        </h1>
        <input
          id="ds-page-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, width: 200, outline: 'none' }}
        />
        <button
          id="ds-page-import"
          onClick={() => setShowImport(true)}
          style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer' }}
        >
          ↓ Import
        </button>
      </div>

      {/* Category pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <button
          onClick={() => setCategory('all')}
          style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: `1px solid ${category === 'all' ? 'var(--color-accent)' : 'var(--color-border)'}`, background: category === 'all' ? 'rgba(124,109,250,0.15)' : 'transparent', color: category === 'all' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
        >
          All ({catalog.length})
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: `1px solid ${category === cat ? 'var(--color-accent)' : 'var(--color-border)'}`, background: category === cat ? 'rgba(124,109,250,0.15)' : 'transparent', color: category === cat ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)' }}>Loading design systems...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map((ds) => (
            <DSCard
              key={ds.id}
              ds={ds}
              isSelected={ds.id === selectedDesignSystemId}
              onView={() => setViewingId(ds.id)}
              onSelect={() => setSelectedDS(ds.id)}
            />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {viewingId && (
        <DSDetailDrawer
          dsId={viewingId}
          onClose={() => setViewingId(null)}
          onSelect={(id) => { setSelectedDS(id); setViewingId(null); }}
          isSelected={viewingId === selectedDesignSystemId}
        />
      )}

      {/* Import dialog */}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onImported={(projectId) => { setShowImport(false); navigate(`/projects/${projectId}`); }}
        />
      )}
    </div>
  );
}
