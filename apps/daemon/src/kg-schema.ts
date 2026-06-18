// Declarative KG push schema — the single place that defines HOW a CJ/UX Spec
// document maps to KGS nodes + edges. `pushDocument` (kg-routes.ts) is a generic
// engine that walks this schema; it has NO hard-coded labels/props/relations.
//
// To change the mapping (new field, label, or edge), edit ONLY this file (and
// keep it in sync with preview-content's node_mapper, which is the consumer
// contract on the SimStudio side).

/** emotion → numeric score (1..5) so the customer-journey emotion curve renders. */
export const EMOTION_SCORE: Record<string, number> = {
  frustrated: 1,
  anxious: 2,
  neutral: 3,
  satisfied: 4,
  delighted: 5,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = any;
type Props = Record<string, unknown>;

/** A nested collection on a parent item (journey.stages, screen.components). */
export interface KgChildDef {
  /** key on the parent item holding the child array */
  key: string;
  label: string;
  id: (item: Item, parentId: string, idx: number) => string;
  props: (item: Item, parentId: string, idx: number) => Props;
  /** relation created parent → child (omit for no edge) */
  edgeToParent?: string;
}

/** A cross-collection edge from an item to another existing node by id. */
export interface KgLinkDef {
  relation: string;
  /** resolve the target node id (edge created only if that node exists) */
  target: (item: Item) => string | undefined;
}

/** A top-level entity collection on the document (personas, journeys, screens). */
export interface KgEntityDef {
  /** key on the document holding the array */
  key: 'personas' | 'journeys' | 'screens';
  label: string;
  id: (item: Item, projectId: string, idx: number) => string;
  props: (item: Item) => Props;
  children?: KgChildDef[];
  links?: KgLinkDef[];
}

export const KG_SCHEMA: KgEntityDef[] = [
  {
    key: 'personas',
    label: 'UX_PERSONA_PROFILE',
    id: (p, projectId, i) => p.id || `PRSN-${projectId}-${i + 1}`,
    props: (p) => {
      const { id: _omit, ...rest } = p;
      return rest;
    },
  },
  {
    key: 'journeys',
    label: 'USER_FLOW',
    id: (j) => j.id,
    props: (j) => ({
      name: j.name,
      title: j.title ?? j.name,
      actor: j.actor_id ?? '',
      actor_id: j.actor_id ?? '',
      journey_mode: j.journey_mode ?? 'to_be',
      goal: j.goal ?? '',
      flow_type: j.flow_type ?? 'primary',
    }),
    children: [
      {
        key: 'stages',
        label: 'STAGE',
        id: (st) => st.id,
        props: (st, parentId, idx) => {
          const emo = st.emotion ?? 'neutral';
          return {
            name: st.name,
            user_flow_id: parentId, // node_mapper STAGE link (prop, mirrors edge)
            flow_id: parentId, // accepted alias
            order: st.order ?? idx + 1,
            stage_type: st.stage_type ?? 'action',
            goal: st.goal ?? '',
            emotion: emo,
            emotion_score: EMOTION_SCORE[emo] ?? 3,
            user_actions: st.user_actions ?? [],
            system_responses: st.system_responses ?? [],
            touchpoints: st.touchpoints ?? [],
            pain_points: st.pain_points ?? [],
            thoughts: st.thoughts ?? [],
          };
        },
        edgeToParent: 'S_HAS_STAGE', // USER_FLOW → STAGE
      },
    ],
    links: [
      { relation: 'S_HAS_ACTOR', target: (j) => j.actor_id }, // USER_FLOW → persona (if exists)
    ],
  },
  {
    key: 'screens',
    label: 'S_SCREEN_SPEC',
    id: (s) => s.id,
    props: (s) => ({
      title: s.title ?? s.name ?? s.id,
      name: s.name ?? s.title ?? s.id,
      screen_type: s.screen_type ?? '',
      screen_intent: s.screen_intent ?? '',
      layout: s.layout ?? '',
      primary_actor: s.primary_actor ?? s.actor_id ?? '',
      actor_id: s.actor_id ?? s.primary_actor ?? '',
      permissions: s.permissions ?? [],
      navigation_group: s.navigation_group ?? '',
    }),
    children: [
      {
        key: 'components',
        label: 'DP_UI_COMPONENT',
        id: (c, parentId, idx) => c.id || `${parentId}-c${idx + 1}`,
        props: (c, parentId, idx) => {
          const { id: _omit, ...rest } = c;
          return {
            ...rest,
            screen_id: parentId, // node_mapper component→screen link (mirrors edge)
            component_type: c.component_type ?? 'text',
            label: c.label ?? '',
            order: c.order ?? idx + 1,
            required: c.required ?? false,
          };
        },
        edgeToParent: 'HAS_COMPONENT', // S_SCREEN_SPEC → DP_UI_COMPONENT
      },
    ],
  },
];

/** Map a node label → the response counter field it feeds. */
export const LABEL_COUNTER: Record<string, 'personas' | 'journeys' | 'stages' | 'screens' | 'components'> = {
  UX_PERSONA_PROFILE: 'personas',
  USER_FLOW: 'journeys',
  STAGE: 'stages',
  S_SCREEN_SPEC: 'screens',
  DP_UI_COMPONENT: 'components',
};
