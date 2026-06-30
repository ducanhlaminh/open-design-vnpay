// Shared DTOs for `POST /api/kg/push` — push a Customer Journey + UX Spec
// document (produced by the `customer-journey-spec` skill) into the Knowledge
// Graph Service (KGS) open-design producer app. KGS projects the written nodes
// to Neo4j; SimStudio (ui/preview) then "Pull All" materialises them onto its
// /customer-journey and /ux-spec screens, scoped by project_id.
//
// This is the daemon-side equivalent of the skill's scripts/push_to_kgs.py:
// labels + props are chosen to match preview-content's node_mapper exactly
//   USER_FLOW          -> journeys        (id, name, actor, project_id, ...)
//   STAGE              -> journey_steps   (id, user_flow_id, order, name, project_id, ...)
//   UX_PERSONA_PROFILE -> ux_personas     (id, name, project_id, ...)
//
// The capability is dual-track: the web "Push to KG" button (FileViewer) and
// `od kg push` both call this endpoint.

/**
 * Bumped when the request/response shape changes incompatibly. Also a real
 * runtime export so esbuild emits a `.mjs` for this otherwise type-only module
 * (NodeNext consumers cannot re-export a purely type-only file from the root).
 */
export const KG_PUSH_SCHEMA_VERSION = 1;

/** One stage (journey step) inside a journey. */
export interface KgPushStage {
  id: string;
  name: string;
  order?: number;
  stage_type?: string;
  goal?: string;
  /** frustrated | anxious | neutral | satisfied | delighted */
  emotion?: string;
  user_actions?: string[];
  system_responses?: string[];
  touchpoints?: string[];
  pain_points?: string[];
  thoughts?: string[];
}

/** One customer journey (USER_FLOW). */
export interface KgPushJourney {
  id: string;
  name: string;
  title?: string;
  actor_id?: string;
  /** to_be | as_is */
  journey_mode?: string;
  goal?: string;
  flow_type?: string;
  stages?: KgPushStage[];
}

/** One UX persona (UX_PERSONA_PROFILE). `id` optional — auto-generated. */
export interface KgPushPersona {
  id?: string;
  name: string;
  [key: string]: unknown;
}

/** One component on a screen (DP_UI_COMPONENT). `id` optional — auto-generated. */
export interface KgPushComponent {
  id?: string;
  component_type?: string;
  label?: string;
  field_binding?: string;
  data_type?: string;
  semantic_type?: string;
  required?: boolean;
  order?: number;
  [key: string]: unknown;
}

/** One UX Spec screen (S_SCREEN_SPEC) — the per-screen box-text mockup. */
export interface KgPushScreen {
  id: string;
  /** Screen title (mapped to the `name` column). */
  name?: string;
  title?: string;
  screen_type?: string;
  screen_intent?: string;
  layout?: string;
  /** Primary actor (accepts `actor_id` as an alias). */
  primary_actor?: string;
  actor_id?: string;
  permissions?: string[];
  navigation_group?: string;
  /** Components shown on the screen — drive the box-text render. */
  components?: KgPushComponent[];
}

/** The CJ + UX Spec document shape (mirrors references/schema.md). */
export interface KgPushDocument {
  project_id?: string;
  personas?: KgPushPersona[];
  journeys?: KgPushJourney[];
  /** UX Spec screens (S_SCREEN_SPEC) shown on SimStudio's /ux-spec. */
  screens?: KgPushScreen[];
}

/** A SimStudio project the user can target (from preview-project). */
export interface KgProject {
  id: string;
  name: string;
}

/** Response for `GET /api/kg/projects`. */
export interface KgProjectsResponse {
  projects: KgProject[];
}

/**
 * Request body for `POST /api/kg/push`.
 *
 * Exactly one of `filePath` (a path relative to the project dir, read by the
 * daemon) or `json` (an inline document) must be provided. `projectId` is the
 * KGS scope key (every node is tagged `project_id`); it overrides any
 * `project_id` embedded in the document.
 */
export interface KgPushRequest {
  /** SimStudio/KGS project scope key, e.g. "xpos". Tags every node. Required. */
  projectId: string;
  /** Inline CJ/UX document. Preferred (the web viewer already holds the file). */
  json?: KgPushDocument;
  /**
   * Path to a CJ/UX JSON file relative to an open-design project dir
   * (alternative to `json`). Requires `odProjectId` to locate the owning
   * project. The `od kg push <file>` CLI reads the file itself and sends
   * `json`, so this path is mainly for callers that prefer server-side read.
   */
  filePath?: string;
  /** open-design project that owns `filePath` (the .od project id). */
  odProjectId?: string;
}

/** Response for `POST /api/kg/push`. */
export interface KgPushResponse {
  ok: boolean;
  /** Total nodes written (personas + journeys + stages + screens + components). */
  pushed: number;
  personas: number;
  journeys: number;
  stages: number;
  screens: number;
  components: number;
  /** Edges written (USER_FLOW→STAGE, screen→component, journey→actor). */
  edges: number;
  /** Per-node failures that were not fatal (e.g. a single 4xx). */
  warnings?: string[];
  error?: string;
}

// ── Validation ────────────────────────────────────────────────────────────
// Shared, dependency-free schema validator for a CJ/UX Spec document. Used by
// BOTH the web "Push to KG" button (to gate the button) and the daemon push
// route (defense in depth). Push is allowed only when this passes AND a target
// project is chosen. Note: `project_id` is intentionally NOT validated here —
// it is filled at push time, never in the document.

export interface KgValidationResult {
  valid: boolean;
  errors: string[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a CJ/UX Spec document against the KG schema. Checks structure and
 * required fields for journeys/stages, screens/components, and personas, that
 * at least one section is present, and that node ids are unique.
 */
export function validateKgPushDocument(doc: unknown): KgValidationResult {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['Document must be a JSON object.'] };
  }
  const d = doc as Record<string, unknown>;

  if ('project_id' in d) {
    errors.push('Remove "project_id" — it is filled at push time, not in the document.');
  }

  const journeys = Array.isArray(d.journeys) ? d.journeys : [];
  const screens = Array.isArray(d.screens) ? d.screens : [];
  const personas = Array.isArray(d.personas) ? d.personas : [];

  if (journeys.length === 0 && screens.length === 0 && personas.length === 0) {
    errors.push('Document has no journeys, screens, or personas — nothing to push.');
  }

  const ids = new Set<string>();
  const seeId = (id: string, where: string) => {
    if (ids.has(id)) errors.push(`Duplicate id "${id}" (${where}).`);
    else ids.add(id);
  };

  journeys.forEach((j, i) => {
    if (!j || typeof j !== 'object') {
      errors.push(`journeys[${i}] must be an object.`);
      return;
    }
    const o = j as Record<string, unknown>;
    if (!isNonEmptyString(o.id)) errors.push(`journeys[${i}].id is required (non-empty string).`);
    else seeId(o.id, `journeys[${i}]`);
    if (!isNonEmptyString(o.name)) errors.push(`journeys[${i}].name is required.`);
    const stages = Array.isArray(o.stages) ? o.stages : [];
    stages.forEach((s, k) => {
      if (!s || typeof s !== 'object') {
        errors.push(`journeys[${i}].stages[${k}] must be an object.`);
        return;
      }
      const so = s as Record<string, unknown>;
      if (!isNonEmptyString(so.id)) errors.push(`journeys[${i}].stages[${k}].id is required.`);
      else seeId(so.id, `journeys[${i}].stages[${k}]`);
      if (!isNonEmptyString(so.name)) errors.push(`journeys[${i}].stages[${k}].name is required.`);
    });
  });

  screens.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      errors.push(`screens[${i}] must be an object.`);
      return;
    }
    const o = s as Record<string, unknown>;
    if (!isNonEmptyString(o.id)) errors.push(`screens[${i}].id is required.`);
    else seeId(o.id, `screens[${i}]`);
    if (!isNonEmptyString(o.name) && !isNonEmptyString(o.title)) {
      errors.push(`screens[${i}] needs a name or title.`);
    }
    const components = Array.isArray(o.components) ? o.components : [];
    components.forEach((c, k) => {
      if (!c || typeof c !== 'object') {
        errors.push(`screens[${i}].components[${k}] must be an object.`);
        return;
      }
      const co = c as Record<string, unknown>;
      if ('id' in co && co.id !== undefined && !isNonEmptyString(co.id)) {
        errors.push(`screens[${i}].components[${k}].id must be a non-empty string when present.`);
      } else if (isNonEmptyString(co.id)) {
        seeId(co.id, `screens[${i}].components[${k}]`);
      }
    });
  });

  personas.forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      errors.push(`personas[${i}] must be an object.`);
      return;
    }
    const o = p as Record<string, unknown>;
    if (!isNonEmptyString(o.name)) errors.push(`personas[${i}].name is required.`);
    if (isNonEmptyString(o.id)) seeId(o.id, `personas[${i}]`);
  });

  return { valid: errors.length === 0, errors };
}
