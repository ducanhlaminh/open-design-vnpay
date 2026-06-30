#!/usr/bin/env python3
"""
push_to_kgs.py — push Customer Journey + UX Spec JSON into KGS (open-design app).

This is the WRITE half of the `customer-journey-spec` skill. The agent generates
a JSON file (see references/schema.md), then this script materialises it as KGS
nodes in the OPEN-DESIGN producer app so SimStudio (ui/preview) can Pull All and
render it on /customer-journey and /ux-spec.

WHY a script (not the kg_* MCP tools): the kg_* tools are READ-ONLY. KGS writes
go through the graph write API (`POST /v1/graph/nodes`), which is what KGS's
outbox needs so the node is projected to Neo4j — and SimStudio's /sync/pull reads
the Neo4j projection via GetFullGraph. A direct DB insert would NOT be projected
and would be invisible to Pull All.

Every node is tagged with `project_id` so /sync/pull scopes it to the right
project (multi-project safe).

Labels + props are chosen to match preview-content's node_mapper exactly:
  USER_FLOW          -> journeys        (props: id, name, actor, project_id, ...)
  STAGE              -> journey_steps   (props: id, user_flow_id, order, name, project_id, ...)
  UX_PERSONA_PROFILE -> ux_personas     (props: id, name, project_id, ...)
  S_SCREEN_SPEC      -> screens         (props: id, title, screen_type, primary_actor, project_id, ...)
  DP_UI_COMPONENT    -> ui_components   (props: id, screen_id, component_type, label, project_id, ...)

Usage:
  KGS_URL=http://localhost:28001 \
  KGS_API_KEY=<design-v3 app key> \
  KGS_APP_ID=design-v3 \
  python3 push_to_kgs.py <journeys.json> [--project-id xpos] [--dry-run]

`project_id` falls back to the JSON's top-level "project_id" field, then the
PROJECT_ID env var.
"""
import json
import os
import sys
import urllib.request
import urllib.error

KGS_URL = os.environ.get("KGS_URL", "http://localhost:28001")
API_KEY = os.environ.get("KGS_API_KEY", "")
APP_ID = os.environ.get("KGS_APP_ID", "design-v3")
TENANT = os.environ.get("KGS_TENANT", "default")
TIMEOUT = 15

# UX-base emotion → numeric score (mirrors seed-ux-kg.py so the SimStudio
# customer-journey emotion curve renders).
EMOTION_SCORE = {"frustrated": 1, "anxious": 2, "neutral": 3, "satisfied": 4, "delighted": 5}


def kgs_call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{KGS_URL}{path}", data=data, method=method,
        headers={"Content-Type": "application/json", "X-API-Key": API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return {"_error": e.read().decode()[:200], "_status": e.code}
    except Exception as e:  # noqa: BLE001
        return {"_error": str(e)[:200], "_status": 0}


def node(node_id, label, props, project_id, dry_run):
    props = dict(props)
    props["id"] = node_id
    props["app_id"] = APP_ID
    props["project_id"] = project_id          # ← scope to the project (REQUIRED)
    props["_seed"] = "open-design-cj"
    if dry_run:
        print(f"  [dry] {label:20s} {node_id:24s} project_id={project_id}")
        return True
    r = kgs_call("POST", "/v1/graph/nodes",
                 {"label": label, "propertiesJson": json.dumps(props, ensure_ascii=False)})
    if "_error" in r and r.get("_status") != 409:   # 409 = already exists → OK
        print(f"  ✗ {label:20s} {node_id:24s} {r.get('_error','')[:80]}")
        return False
    return True


def edge(source_id, target_id, relation_type, dry_run):
    if not source_id or not target_id:
        return False
    if dry_run:
        print(f"  [dry] edge {relation_type:14s} {source_id} -> {target_id}")
        return True
    r = kgs_call("POST", "/v1/graph/edges", {
        "sourceNodeId": source_id, "targetNodeId": target_id,
        "relationType": relation_type,
        "propertiesJson": json.dumps({"app_id": APP_ID, "_seed": "open-design-cj"}),
    })
    if "_error" in r and r.get("_status") != 409:
        print(f"  ✗ edge {relation_type} {source_id}->{target_id} {r.get('_error','')[:60]}")
        return False
    return True


def _nes(v):
    return isinstance(v, str) and v.strip() != ""


def validate_doc(doc):
    """Validate a CJ/UX Spec document against the KG schema. Mirrors the shared
    TS validator (packages/contracts validateKgPushDocument). Returns a list of
    error strings ([] = valid). project_id must NOT be in the doc — it is filled
    at push time."""
    errors = []
    if not isinstance(doc, dict):
        return ["Document must be a JSON object."]
    if "project_id" in doc:
        errors.append('Remove "project_id" — it is filled at push time, not in the document.')
    journeys = doc.get("journeys") if isinstance(doc.get("journeys"), list) else []
    screens = doc.get("screens") if isinstance(doc.get("screens"), list) else []
    personas = doc.get("personas") if isinstance(doc.get("personas"), list) else []
    if not journeys and not screens and not personas:
        errors.append("Document has no journeys, screens, or personas — nothing to push.")
    ids = set()

    def see(i, where):
        if i in ids:
            errors.append(f'Duplicate id "{i}" ({where}).')
        else:
            ids.add(i)

    for i, j in enumerate(journeys):
        if not isinstance(j, dict):
            errors.append(f"journeys[{i}] must be an object."); continue
        if not _nes(j.get("id")):
            errors.append(f"journeys[{i}].id is required.")
        else:
            see(j["id"], f"journeys[{i}]")
        if not _nes(j.get("name")):
            errors.append(f"journeys[{i}].name is required.")
        stages = j.get("stages") if isinstance(j.get("stages"), list) else []
        for k, s in enumerate(stages):
            if not isinstance(s, dict):
                errors.append(f"journeys[{i}].stages[{k}] must be an object."); continue
            if not _nes(s.get("id")):
                errors.append(f"journeys[{i}].stages[{k}].id is required.")
            else:
                see(s["id"], f"journeys[{i}].stages[{k}]")
            if not _nes(s.get("name")):
                errors.append(f"journeys[{i}].stages[{k}].name is required.")
    for i, s in enumerate(screens):
        if not isinstance(s, dict):
            errors.append(f"screens[{i}] must be an object."); continue
        if not _nes(s.get("id")):
            errors.append(f"screens[{i}].id is required.")
        else:
            see(s["id"], f"screens[{i}]")
        if not _nes(s.get("name")) and not _nes(s.get("title")):
            errors.append(f"screens[{i}] needs a name or title.")
        comps = s.get("components") if isinstance(s.get("components"), list) else []
        for k, c in enumerate(comps):
            if not isinstance(c, dict):
                errors.append(f"screens[{i}].components[{k}] must be an object."); continue
            if _nes(c.get("id")):
                see(c["id"], f"screens[{i}].components[{k}]")
    for i, p in enumerate(personas):
        if not isinstance(p, dict):
            errors.append(f"personas[{i}] must be an object."); continue
        if not _nes(p.get("name")):
            errors.append(f"personas[{i}].name is required.")
        if _nes(p.get("id")):
            see(p["id"], f"personas[{i}]")
    return errors


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    project_cli = None
    for a in sys.argv:
        if a.startswith("--project-id="):
            project_cli = a.split("=", 1)[1]
    if "--project-id" in sys.argv:
        i = sys.argv.index("--project-id")
        if i + 1 < len(sys.argv):
            project_cli = sys.argv[i + 1]
    if not args:
        print("usage: push_to_kgs.py <journeys.json> [--project-id X] [--dry-run]")
        sys.exit(2)

    doc = json.load(open(args[0], encoding="utf-8"))

    # Validate against the KG schema before doing anything (same rules as the
    # web Push to KG button + daemon). Refuse to push an invalid document.
    verrors = validate_doc(doc)
    if verrors:
        print("✗ KG schema validation failed:")
        for e in verrors:
            print(f"  - {e}")
        sys.exit(1)

    project_id = project_cli or doc.get("project_id") or os.environ.get("PROJECT_ID", "")
    if not project_id:
        print("ERROR: project_id required (--project-id, JSON.project_id, or PROJECT_ID env)")
        sys.exit(2)
    if not API_KEY and not dry_run:
        print("ERROR: KGS_API_KEY required (open-design app key)")
        sys.exit(2)

    print(f"▶ Push CJ/UX → KGS app={APP_ID} project_id={project_id} ({'DRY' if dry_run else KGS_URL})")
    ok = 0
    edge_list = []          # (source, target, relation) — created after all nodes
    persona_ids = set()

    # ── Personas → UX_PERSONA_PROFILE ──────────────────────────────────────
    personas = doc.get("personas", [])
    print(f"[1/2] UX_PERSONA_PROFILE ({len(personas)})")
    for i, p in enumerate(personas, 1):
        pid = p.get("id") or f"PRSN-{project_id}-{i}"
        persona_ids.add(pid)
        if node(pid, "UX_PERSONA_PROFILE",
                {k: v for k, v in p.items() if k != "id"}, project_id, dry_run):
            ok += 1

    # ── Journeys → USER_FLOW + STAGE ───────────────────────────────────────
    journeys = doc.get("journeys", [])
    stage_n = 0
    print(f"[2/2] USER_FLOW + STAGE ({len(journeys)} journeys)")
    for j in journeys:
        if node(j["id"], "USER_FLOW", {
            "name": j["name"], "title": j.get("title", j["name"]),
            "actor": j.get("actor_id", ""),
            "actor_id": j.get("actor_id", ""),
            "journey_mode": j.get("journey_mode", "to_be"),
            "goal": j.get("goal", ""),
            "flow_type": j.get("flow_type", "primary"),
        }, project_id, dry_run):
            ok += 1
        for idx, st in enumerate(j.get("stages", []), 1):
            emo = st.get("emotion", "neutral")
            if node(st["id"], "STAGE", {
                "name": st["name"],
                "user_flow_id": j["id"],          # node_mapper STAGE link (prop, not edge)
                "flow_id": j["id"],               # accepted alias
                "order": st.get("order", idx),
                "stage_type": st.get("stage_type", "action"),
                "goal": st.get("goal", ""),
                "emotion": emo,
                "emotion_score": EMOTION_SCORE.get(emo, 3),
                "user_actions": st.get("user_actions", []),
                "system_responses": st.get("system_responses", []),
                "touchpoints": st.get("touchpoints", []),
                "pain_points": st.get("pain_points", []),
                "thoughts": st.get("thoughts", []),
            }, project_id, dry_run):
                ok += 1
                stage_n += 1
                edge_list.append((j["id"], st["id"], "S_HAS_STAGE"))   # USER_FLOW → STAGE
        actor = j.get("actor_id", "")
        if actor and actor in persona_ids:
            edge_list.append((j["id"], actor, "S_HAS_ACTOR"))          # USER_FLOW → PERSONA

    # ── UX Spec screens → S_SCREEN_SPEC + components → DP_UI_COMPONENT ──────
    screens = doc.get("screens", [])
    comp_n = 0
    print(f"[3/3] S_SCREEN_SPEC + DP_UI_COMPONENT ({len(screens)} screens)")
    for s in screens:
        if node(s["id"], "S_SCREEN_SPEC", {
            "title": s.get("title", s.get("name", s["id"])),
            "name": s.get("name", s.get("title", s["id"])),
            "screen_type": s.get("screen_type", ""),
            "screen_intent": s.get("screen_intent", ""),
            "layout": s.get("layout", ""),
            "primary_actor": s.get("primary_actor", s.get("actor_id", "")),
            "actor_id": s.get("actor_id", s.get("primary_actor", "")),
            "permissions": s.get("permissions", []),
            "navigation_group": s.get("navigation_group", ""),
        }, project_id, dry_run):
            ok += 1
        for ci, c in enumerate(s.get("components", []), 1):
            cid = c.get("id") or f"{s['id']}-c{ci}"
            props = {k: v for k, v in c.items() if k != "id"}
            props.update({
                "screen_id": s["id"],            # node_mapper component→screen link
                "component_type": c.get("component_type", "text"),
                "label": c.get("label", ""),
                "order": c.get("order", ci),
                "required": c.get("required", False),
            })
            if node(cid, "DP_UI_COMPONENT", props, project_id, dry_run):
                ok += 1
                comp_n += 1
                edge_list.append((s["id"], cid, "HAS_COMPONENT"))      # SCREEN → COMPONENT

    # ── Edges (after all nodes exist) ──────────────────────────────────────
    edge_n = 0
    print(f"[edges] ({len(edge_list)})")
    for src, tgt, rel in edge_list:
        if edge(src, tgt, rel, dry_run):
            edge_n += 1

    print(f"✔ pushed {ok} nodes + {edge_n} edges ({len(personas)} personas, {len(journeys)} journeys, "
          f"{stage_n} stages, {len(screens)} screens, {comp_n} components)")
    if not dry_run:
        print("→ Next: in SimStudio, select the project and click 'Pull All' to view "
              "on /customer-journey and /ux-spec.")


if __name__ == "__main__":
    main()
