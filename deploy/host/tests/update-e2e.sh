#!/usr/bin/env bash
# Open Design — host-runtime UPDATE end-to-end test (macOS).
#
# CI xanh o day nghia la: mot may dang chay ban phat hanh THAT truoc do
# (N-1, tai tu https://od-runtime.pages.dev) co the bam "Cap nhat" tren
# Web UI va len duoc ban HEAD. Truoc script nay, workflow chi smoke-test
# CAI MOI -- duong --update / POST /api/update/apply chua co o test nao.
#
# Hai stage, chay trong 1 process:
#
#   Stage 1 (duong may truong)
#     1. Cai ban N-1 THAT tu mirror mac dinh (curl | bash --port <port>).
#     2. Chay update bang DUNG installer N-1 dang cai
#        ($OD_HOME/current/install.sh --update), tro OD_RELEASE_URL vao
#        mot mirror noi bo (HTTP server cuc bo) phuc vu ban 9.9.1.
#     3. Assert healthy + currentVersion == 9.9.1.
#
#   Stage 2 (duong Web UI, tren daemon HEAD vua len o Stage 1)
#     1. Ghi OD_RELEASE_URL tro sang mirror noi bo ban 9.9.2 vao
#        config.env, restart qua launchctl kickstart -k.
#     2. POST /api/update/apply (dung nhu nut "Cap nhat" tren Web UI),
#        poll GET /api/update/status toi currentVersion == 9.9.2.
#     3. Assert /api/skills > 0 (hoi quy config.env -> process env).
#
# 9.9.1 / 9.9.2 duoc chon de LUON lon hon moi ban that tren mirror/GitHub,
# ke ca sau khi workflow nay re-run muon hon lan release that gan nhat.
#
# Toan bo tarball 9.9.x duoc dung lai TU tarball artifact da build san
# (OD_E2E_TARBALL) -- chi sua file VERSION o goc release roi dong goi lai
# 2 lan, khong build lai daemon/web. Xem apps/daemon/src/app-version.ts
# (readCurrentAppVersionInfo) + deploy/host/install.sh's write_config_env:
# VERSION trong tarball la nguon DUY NHAT duoc doc luc runtime (qua
# OD_APP_VERSION trong config.env) -- da kiem tra thuc te, khong con noi
# nao khac can sua.
#
# AN TOAN: SERVICE_LABEL ("com.vnpay.open-design") la mot chuoi CO DINH,
# toan cuc trong launchd domain gui/$(id -u) -- KHONG phu thuoc $HOME. Vi
# vay du OD_E2E_HOME tro vao mot thu muc scratch, daemon test van dang ky
# WOI CUNG mot nhan trong CUNG mot domain nhu mot ban cai that. Guard ben
# duoi phai chay TRUOC bat cu thao tac nao va ABORT ngay neu nhan do dang
# loaded -- xem comment o guard_preflight().
#
# Env / tham so:
#   OD_E2E_TARBALL       (required) duong dan .tar.gz da build (build-runtime.sh)
#   OD_E2E_PLATFORM       platform id, mac dinh darwin-arm64
#   OD_E2E_SERVE_PORT     port cua HTTP server mirror noi bo, mac dinh 8919
#   OD_E2E_PORT           port daemon, mac dinh 7456 (khop CI)
#   OD_E2E_HOME           (khuyen nghi khi chay local) HOME scratch -- MOI lenh
#                          installer/launchctl-lien-quan chay voi HOME nay.
#                          KHONG duoc trung / nam trong $HOME that.
#
# Usage (CI):   OD_E2E_TARBALL=<tarball> bash deploy/host/tests/update-e2e.sh
# Usage (local):
#   OD_E2E_TARBALL=<tarball> OD_E2E_HOME=<scratch> \
#   OD_E2E_PORT=47456 OD_E2E_SERVE_PORT=48919 \
#   bash deploy/host/tests/update-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SERVICE_LABEL="com.vnpay.open-design"
MIRROR_BASE_URL="https://od-runtime.pages.dev/latest"
GH_REPO="ducanhlaminh/open-design-vnpay"
V1="9.9.1"
V2="9.9.2"

log()   { printf '[update-e2e] %s\n' "$1"; }
phase() { printf '\n[update-e2e] ==== %s ====\n' "$1"; }
fail()  { printf '[update-e2e] ERROR: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "update-e2e.sh only runs on macOS (got $(uname -s))"
for tool in curl tar python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool not found on PATH: ${tool}"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
  || fail "neither sha256sum nor shasum found on PATH"

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
: "${OD_E2E_TARBALL:?set OD_E2E_TARBALL to the built .tar.gz path (see scripts/host-runtime/build-runtime.sh)}"
OD_E2E_PLATFORM="${OD_E2E_PLATFORM:-darwin-arm64}"
OD_E2E_SERVE_PORT="${OD_E2E_SERVE_PORT:-8919}"
OD_E2E_PORT="${OD_E2E_PORT:-7456}"
OD_E2E_HOME="${OD_E2E_HOME:-}"

case "$OD_E2E_TARBALL" in
  /*) : ;;
  *) OD_E2E_TARBALL="$(cd "$(dirname "$OD_E2E_TARBALL")" && pwd)/$(basename "$OD_E2E_TARBALL")" ;;
esac
[ -f "$OD_E2E_TARBALL" ] || fail "OD_E2E_TARBALL not found: ${OD_E2E_TARBALL}"

REAL_HOME="$HOME"
EFFECTIVE_HOME="${OD_E2E_HOME:-$REAL_HOME}"

# ---------------------------------------------------------------------------
# State tracked for teardown/dump (populated as stages progress)
# ---------------------------------------------------------------------------
SERVE_ROOT=""
WORK=""
HTTP_SERVER_PID=""
BOOTSTRAPPED=0

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

wait_for_health() {
  local port="$1" timeout="${2:-60}" elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

set_config_env_kv() {
  # Replace (or append) a KEY=VALUE line in a config.env-style file.
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    local tmp="${file}.tmp.$$"
    sed "s#^${key}=.*#${key}=${value}#" "$file" >"$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

json_field() {
  # JSON text arrives on stdin; $1 = top-level field name to extract.
  # Missing key / null -> empty string (never "None"/"null").
  local field="$1"
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('')
    raise SystemExit
v = d.get('${field}') if isinstance(d, dict) else None
print('' if v is None else v)
"
}

# ---------------------------------------------------------------------------
# Dump + teardown -- ALWAYS runs (trap), even on a mid-stage failure. Order
# matters: dump logs FIRST (while files still exist), only then clean up.
# ---------------------------------------------------------------------------
dump_logs() {
  log "---- dumping logs for debugging ----"
  local od_home="${EFFECTIVE_HOME}/.open-design"
  local data_dir
  data_dir="$(grep -E '^OD_DATA_DIR=' "${od_home}/config.env" 2>/dev/null | tail -1 | cut -d= -f2-)"
  data_dir="${data_dir:-${EFFECTIVE_HOME}/od-data/open-design}"
  local f
  for f in "${data_dir}/update.log" "${data_dir}/update-state.json" \
    "${od_home}/logs/open-design.out.log" "${od_home}/logs/open-design.err.log"; do
    echo "===== ${f} (last 200 lines)"
    tail -n 200 "$f" 2>/dev/null || echo "(missing)"
  done
  echo "===== launchctl print gui/$(id -u)/${SERVICE_LABEL}"
  launchctl print "gui/$(id -u)/${SERVICE_LABEL}" 2>&1 | head -80 || true
  echo "===== HTTP mirror server log"
  [ -n "$WORK" ] && tail -n 100 "${WORK}/http-server.log" 2>/dev/null || echo "(missing)"
}

teardown() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    dump_logs || true
  fi
  log "---- teardown (exit=${exit_code}) ----"

  if [ -n "$HTTP_SERVER_PID" ]; then
    kill "$HTTP_SERVER_PID" >/dev/null 2>&1 || true
    wait "$HTTP_SERVER_PID" 2>/dev/null || true
  fi

  if [ "$BOOTSTRAPPED" = "1" ]; then
    launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  fi
  rm -f "${EFFECTIVE_HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist" 2>/dev/null || true
  rm -rf "${EFFECTIVE_HOME}/.open-design" 2>/dev/null || true

  # Scratch HOME (local verify runs) -- remove the whole throwaway tree too
  # (od-data/, tools/, everything). Never touches the real $HOME.
  if [ -n "$OD_E2E_HOME" ] && [ "$OD_E2E_HOME" != "$REAL_HOME" ]; then
    rm -rf "$OD_E2E_HOME" 2>/dev/null || true
  fi

  [ -n "$SERVE_ROOT" ] && rm -rf "$SERVE_ROOT" 2>/dev/null || true
  [ -n "$WORK" ] && rm -rf "$WORK" 2>/dev/null || true

  exit "$exit_code"
}
trap teardown EXIT INT TERM

# ---------------------------------------------------------------------------
# Safety guard -- MUST run before anything else. See header comment: the
# launchd label is global to gui/$(id -u) regardless of $HOME, so a scratch
# OD_E2E_HOME does NOT isolate us from a real install's LaunchAgent.
# ---------------------------------------------------------------------------
guard_preflight() {
  if [ -n "$OD_E2E_HOME" ]; then
    [ "$OD_E2E_HOME" != "$REAL_HOME" ] \
      || fail "OD_E2E_HOME must not equal the real \$HOME (${REAL_HOME}) -- refusing to risk the real ~/.open-design install"
    case "$OD_E2E_HOME" in
      "${REAL_HOME}"/*) fail "OD_E2E_HOME (${OD_E2E_HOME}) is nested inside the real \$HOME -- use an isolated scratch directory" ;;
    esac
  fi

  if launchctl print "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1; then
    fail "guard: launchd label ${SERVICE_LABEL} is already loaded in gui/$(id -u) -- a real Open Design install may be running on this machine. ABORTING before touching anything (this script would otherwise bootstrap the SAME global label and could tear down the real install)."
  fi

  local port
  for port in "$OD_E2E_PORT" "$OD_E2E_SERVE_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "guard: port ${port} is already in use -- refusing to start"
    fi
  done

  log "guard OK -- label ${SERVICE_LABEL} not loaded, ports ${OD_E2E_PORT}/${OD_E2E_SERVE_PORT} free, HOME=${EFFECTIVE_HOME}"
}

# ---------------------------------------------------------------------------
# Build the two local-mirror release trees (9.9.1 in serve/latest,
# 9.9.2 in serve/latest2) from ONE already-built tarball.
# ---------------------------------------------------------------------------
repack_release() {
  local version="$1" dest_dir="$2" url_path="$3"
  local stage="${WORK}/extract-${version}"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$OD_E2E_TARBALL" -C "$stage"

  local top_dirs top_dir
  top_dirs="$(find "$stage" -mindepth 1 -maxdepth 1 -type d)"
  [ "$(printf '%s\n' "$top_dirs" | grep -c .)" -eq 1 ] \
    || fail "expected exactly one top-level directory in ${OD_E2E_TARBALL}, found: ${top_dirs}"
  top_dir="$top_dirs"
  [ -f "${top_dir}/VERSION" ] || fail "tarball is missing VERSION at its root: ${top_dir}/VERSION"

  # The ONLY place install.sh / the daemon read the version from at
  # runtime -- see readCurrentAppVersionInfo() via config.env's
  # OD_APP_VERSION, written by install.sh from this exact file.
  printf '%s\n' "$version" >"${top_dir}/VERSION"

  mkdir -p "$dest_dir"
  local out_name="open-design-runtime-${version}-${OD_E2E_PLATFORM}.tar.gz"
  (cd "$stage" && tar -czf "${dest_dir}/${out_name}" "$(basename "$top_dir")")
  sha256_of "${dest_dir}/${out_name}" >"${dest_dir}/${out_name}.sha256"

  cp "${REPO_ROOT}/deploy/host/install.sh" "${dest_dir}/install.sh"
  cp "${REPO_ROOT}/deploy/host/install.ps1" "${dest_dir}/install.ps1"

  (
    cd "$dest_dir" \
      && node --experimental-strip-types "${REPO_ROOT}/scripts/host-runtime/build-release-manifest.ts" \
        --version "$version" --tag "test-${version}" --repo "$GH_REPO" \
        --base-url "http://127.0.0.1:${OD_E2E_SERVE_PORT}/${url_path}" --out release.json
  )
  log "repacked ${version} -> ${dest_dir}/${out_name} (release.json base-url http://127.0.0.1:${OD_E2E_SERVE_PORT}/${url_path})"
}

build_local_mirror() {
  phase "Build local mirror (9.9.1 + 9.9.2 from ${OD_E2E_TARBALL})"
  SERVE_ROOT="$(mktemp -d -t od-e2e-serve)"
  WORK="$(mktemp -d -t od-e2e-work)"
  repack_release "$V1" "${SERVE_ROOT}/latest" "latest"
  repack_release "$V2" "${SERVE_ROOT}/latest2" "latest2"

  log "starting local mirror HTTP server on :${OD_E2E_SERVE_PORT} (serving ${SERVE_ROOT})"
  python3 -m http.server "$OD_E2E_SERVE_PORT" --directory "$SERVE_ROOT" >"${WORK}/http-server.log" 2>&1 &
  HTTP_SERVER_PID=$!
  sleep 1
  kill -0 "$HTTP_SERVER_PID" 2>/dev/null || fail "local mirror HTTP server failed to start (see ${WORK}/http-server.log)"

  local ok="" _try
  for _try in $(seq 1 20); do
    curl -fsS "http://127.0.0.1:${OD_E2E_SERVE_PORT}/latest/release.json" >/dev/null 2>&1 && { ok=1; break; }
    sleep 0.5
  done
  [ -n "$ok" ] || fail "local mirror HTTP server not responding on :${OD_E2E_SERVE_PORT}"
  log "[ok] local mirror serving on http://127.0.0.1:${OD_E2E_SERVE_PORT}"
}

# ---------------------------------------------------------------------------
# Stage 1 -- N-1 real installer -> its own --update against local mirror v1
# ---------------------------------------------------------------------------
stage1() {
  phase "Stage 1a: install N-1 (real) from ${MIRROR_BASE_URL}"
  local t0 t1
  t0=$(date +%s)
  curl -fsSL "${MIRROR_BASE_URL}/install.sh" | env HOME="$EFFECTIVE_HOME" bash -s -- --port "$OD_E2E_PORT"
  BOOTSTRAPPED=1
  wait_for_health "$OD_E2E_PORT" 60 || fail "N-1 install did not become healthy within 60s"
  log "[ok] N-1 installed and healthy on port ${OD_E2E_PORT}"

  phase "Stage 1b: update via bundled installer --update -> target ${V1}"
  local current_installer="${EFFECTIVE_HOME}/.open-design/current/install.sh"
  [ -f "$current_installer" ] || fail "bundled install.sh not found at ${current_installer} after N-1 install"
  env HOME="$EFFECTIVE_HOME" OD_RELEASE_URL="http://127.0.0.1:${OD_E2E_SERVE_PORT}/latest" \
    bash "$current_installer" --update

  wait_for_health "$OD_E2E_PORT" 60 || fail "stage 1 update did not become healthy within 60s"
  local status_json current_version
  status_json="$(curl -fsS "http://127.0.0.1:${OD_E2E_PORT}/api/update/status")"
  current_version="$(printf '%s' "$status_json" | json_field currentVersion)"
  [ "$current_version" = "$V1" ] \
    || fail "stage 1: expected /api/update/status currentVersion=${V1}, got '${current_version}' (raw: ${status_json})"

  t1=$(date +%s)
  log "[ok] stage 1 PASS: N-1 -> ${V1} in $((t1 - t0))s"
}

# ---------------------------------------------------------------------------
# Stage 2 -- Web-UI path (POST /api/update/apply) on the daemon HEAD build
# just installed by stage 1, target v2.
# ---------------------------------------------------------------------------
stage2() {
  local t0 t1
  t0=$(date +%s)
  phase "Stage 2a: point OD_RELEASE_URL at local mirror v2 + restart"
  local config_env="${EFFECTIVE_HOME}/.open-design/config.env"
  [ -f "$config_env" ] || fail "missing ${config_env}"
  local new_url="http://127.0.0.1:${OD_E2E_SERVE_PORT}/latest2"
  set_config_env_kv "$config_env" OD_RELEASE_URL "$new_url"

  # CRITICAL SAFETY: also pin HOME itself into config.env. launchd does NOT
  # give a LaunchAgent the $HOME its plist happened to be bootstrapped from
  # -- an already-running daemon's own process.env.HOME is always the real
  # per-user session HOME unless something explicitly overrides it. Without
  # this line, POST /api/update/apply below spawns install.sh as a CHILD of
  # the daemon, that child inherits the daemon's (real) $HOME, and it would
  # install for real onto the real machine's ~/.open-design -- reproduced
  # live once while writing this script (see the report for this WP).
  # config.env is sourced with `set -a` by the launchd plist, so a HOME=
  # line here exports it into the daemon's own process env once restarted.
  set_config_env_kv "$config_env" HOME "$EFFECTIVE_HOME"

  launchctl kickstart -k "gui/$(id -u)/${SERVICE_LABEL}"
  wait_for_health "$OD_E2E_PORT" 60 || fail "daemon did not become healthy after config.env restart"
  log "[ok] daemon restarted with OD_RELEASE_URL -> ${new_url} and HOME pinned -> ${EFFECTIVE_HOME}"

  phase "Stage 2b: POST /api/update/apply -> poll /api/update/status -> target ${V2}"
  local apply_resp
  apply_resp="$(curl -fsS -X POST "http://127.0.0.1:${OD_E2E_PORT}/api/update/apply")"
  log "apply response: ${apply_resp}"

  local timeout=300 elapsed=0 status_json="" final_version="" final_state=""
  while [ "$elapsed" -lt "$timeout" ]; do
    status_json="$(curl -fsS "http://127.0.0.1:${OD_E2E_PORT}/api/update/status" 2>/dev/null || true)"
    if [ -n "$status_json" ]; then
      final_version="$(printf '%s' "$status_json" | json_field currentVersion)"
      final_state="$(printf '%s' "$status_json" | json_field state)"
      if [ "$final_version" = "$V2" ] && { [ "$final_state" = "healthy" ] || [ -z "$final_state" ]; }; then
        break
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  [ "$final_version" = "$V2" ] \
    || fail "stage 2: currentVersion never reached ${V2} within ${timeout}s (last: version='${final_version}' state='${final_state}')"
  if [ -n "$final_state" ] && [ "$final_state" != "healthy" ]; then
    fail "stage 2: reached ${V2} but state='${final_state}' (expected healthy or empty)"
  fi
  log "[ok] currentVersion=${V2} state='${final_state:-<null>}'"

  phase "Stage 2c: assert /api/skills > 0 (config.env -> process env regression)"
  local skills_count
  skills_count="$(curl -fsS "http://127.0.0.1:${OD_E2E_PORT}/api/skills" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("skills") or []))')"
  [ "$skills_count" -gt 0 ] || fail "/api/skills returned 0 skills after update to ${V2}"
  log "[ok] /api/skills returned ${skills_count} skills"

  t1=$(date +%s)
  log "[ok] stage 2 PASS: ${V1} -> ${V2} via Web-UI apply in $((t1 - t0))s"
}

guard_preflight
build_local_mirror
stage1
stage2
log "ALL STAGES PASSED"
