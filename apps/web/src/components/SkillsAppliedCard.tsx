/**
 * "Applied skills" card surfaced above an assistant message. Lists the
 * primary project-persistent skill plus any per-turn @-mention skills
 * the daemon stacked into the system prompt for that run.
 *
 * Data source: the `skills_applied` PersistedAgentEvent synthesized by
 * `providers/daemon.ts` from the SSE start payload. The event lives in
 * the message's `events` array — `AssistantMessage` scans for the first
 * one and renders this card before any tool/text block.
 *
 * Skill metadata (display name, category) is resolved against the
 * `catalog` prop. When a skill id has no catalog match — typical when
 * the catalog hasn't loaded yet or the skill was uninstalled — the chip
 * falls back to the bare id with a dashed border so the user still sees
 * what the agent received.
 */
import type { SkillSummary } from '@open-design/contracts';
import styles from './SkillsAppliedCard.module.css';

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

interface SkillChipProps {
  id: string;
  catalog?: Map<string, SkillSummary>;
  variant: 'primary' | 'adhoc';
}

function SkillChip({ id, catalog, variant }: SkillChipProps) {
  const meta = catalog?.get(id);
  const name = meta?.name ?? id;
  const category = meta?.category ?? undefined;
  const unknown = !meta;

  return (
    <span
      className={classNames(
        styles.chip,
        styles[variant],
        unknown && styles.unknown,
      )}
      title={
        meta?.description
          ? `${name} — ${meta.description}`
          : unknown
            ? `${id} (not found in catalog)`
            : name
      }
    >
      <span className={styles.chipIcon} aria-hidden>
        ✨
      </span>
      <span className={styles.chipName}>{name}</span>
      {category && <span className={styles.chipCategory}>{category}</span>}
      {variant === 'primary' && !unknown && (
        <span className={styles.chipBadge}>primary</span>
      )}
    </span>
  );
}

export interface SkillsAppliedCardProps {
  skillId?: string | null;
  skillIds?: string[];
  catalog?: SkillSummary[];
}

export function SkillsAppliedCard({ skillId, skillIds, catalog }: SkillsAppliedCardProps) {
  const adhoc = (skillIds ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0 && s !== skillId,
  );
  if (!skillId && adhoc.length === 0) return null;

  // Build a small id→summary map once per render; the catalog is short
  // (< a few hundred entries) so a linear scan to keyed lookup is fine.
  const byId = new Map<string, SkillSummary>();
  if (catalog) {
    for (const s of catalog) byId.set(s.id, s);
  }

  const total = (skillId ? 1 : 0) + adhoc.length;

  return (
    <div className={styles.shell} role="group" aria-label="Skills applied">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          ✨
        </span>
        <span className={styles.title}>Skills applied</span>
        <span className={styles.count}>
          {total} {total === 1 ? 'skill' : 'skills'}
        </span>
      </div>
      <div className={styles.chips}>
        {skillId && <SkillChip id={skillId} catalog={byId} variant="primary" />}
        {adhoc.map((id) => (
          <SkillChip key={id} id={id} catalog={byId} variant="adhoc" />
        ))}
      </div>
    </div>
  );
}
