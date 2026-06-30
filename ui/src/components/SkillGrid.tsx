/**
 * F-38 — SkillGrid (+ SkillCard inline)
 * Grid of all skills with search. SkillCard shows hover effects and 2-line description truncation.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SkillSummary } from '../types';

// SkillCard (inline)
function SkillCard({ skill, onClick }: { skill: SkillSummary; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      id={`skill-card-${skill.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        padding: 16,
        borderRadius: 'var(--radius)',
        border: `1px solid ${hovered ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: 'var(--color-surface)',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? '0 4px 14px rgba(124,109,250,0.15)' : 'none',
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
      <div style={{
        fontSize: 13, fontWeight: 600, color: 'var(--color-text)',
        marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {skill.name}
      </div>
      {skill.description && (
        <div style={{
          fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {skill.description}
        </div>
      )}
      {hovered && (
        <div style={{
          marginTop: 10, padding: '4px 0',
          fontSize: 11, color: 'var(--color-accent)', fontWeight: 500,
        }}>
          Use this skill →
        </div>
      )}
    </div>
  );
}

// SkillGrid
interface SkillGridProps {
  onSelectSkill?: (skill: SkillSummary) => void;
}

export function SkillGrid({ onSelectSkill }: SkillGridProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.skills.listSkills()
      .then((resp) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
        setSkills(list);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = skills.filter(
    (s) => !search || s.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          style={{
            padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13,
            outline: 'none', width: 240,
          }}
        />
        {!loading && (
          <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--color-text-muted)' }}>
            {filtered.length} skill{filtered.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: 24, textAlign: 'center' }}>
          Loading skills...
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {filtered.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              onClick={() => onSelectSkill?.(s)}
            />
          ))}
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 48, color: 'var(--color-text-muted)', fontSize: 13 }}>
              No skills found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
