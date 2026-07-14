#!/usr/bin/env bash
# One-time machine setup for the Open Design (VNPAY) desktop app on macOS.
# Run this ONCE, AFTER installing the app into /Applications, and BEFORE
# using pipeline steps for the first time. Double-click it in Finder — it
# opens in Terminal.
#
# What it does:
#   1. Makes sure Docker Desktop is installed and running (pipeline steps
#      run the AI agent inside a sandboxed Docker container).
#   2. Builds the two Docker images the app needs, using the Dockerfiles
#      already bundled inside the installed app (so the version always
#      matches whatever build you have — no download, no version drift).
#   3. Logs the sandbox in to your Claude account once (opens a browser).
# After this finishes, just open the "Open Design" app and log in with Google.
set -euo pipefail

IMAGE_NAME="od-agent-sandbox"
AUTH_VOLUME="od-claude-auth"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

say "Tìm app Open Design đã cài..."
APP_PATH=""
for candidate in "/Applications/Open Design.app" "/Applications/Open Design Beta.app" "/Applications/Open Design Preview.app"; do
  if [ -d "$candidate" ]; then APP_PATH="$candidate"; break; fi
done
if [ -z "$APP_PATH" ]; then
  fail "Không thấy 'Open Design.app' trong /Applications. Cài app (kéo từ file .dmg vào Applications) rồi chạy lại file này."
fi
BUILDER_DIR="$APP_PATH/Contents/Resources/open-design/skills/ui-react/builder"
if [ ! -f "$BUILDER_DIR/Dockerfile" ]; then
  fail "Không thấy cấu hình sandbox bên trong app ($BUILDER_DIR). Bản app này có thể quá cũ — cài lại bản mới rồi chạy lại file này."
fi
ok "Tìm thấy app tại: $APP_PATH"

say "Kiểm tra Docker Desktop..."
if ! command -v docker >/dev/null 2>&1; then
  say "Chưa có Docker — đang cài qua Homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    fail "Chưa có Homebrew. Cài Homebrew trước tại https://brew.sh, hoặc tự cài Docker Desktop tại https://www.docker.com/products/docker-desktop rồi chạy lại file này."
  fi
  brew install --cask docker || fail "Cài Docker Desktop qua Homebrew thất bại. Cài thủ công tại https://www.docker.com/products/docker-desktop rồi chạy lại file này."
  ok "Đã cài Docker Desktop."
fi

say "Khởi động Docker Desktop (nếu chưa chạy)..."
open -a Docker 2>/dev/null || true

printf "Đang chờ Docker khởi động"
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo
    fail "Docker Desktop chưa chạy sau 3 phút. Mở app Docker bằng tay (icon con cá voi), chờ nó chuyển sang trạng thái 'running', rồi chạy lại file này."
  fi
  printf "."
  sleep 3
done
echo
ok "Docker đang chạy."

case "$(uname -m)" in
  arm64) PLATFORM="linux/arm64" ;;
  *)     PLATFORM="linux/amd64" ;;
esac

TOOLKIT_VERSION="$(tr -d '[:space:]' < "$BUILDER_DIR/base/toolkit.version")"
SANDBOX_VERSION="$(tr -d '[:space:]' < "$BUILDER_DIR/sandbox/sandbox.version")"
CLAUDE_VERSION="$(tr -d '[:space:]' < "$BUILDER_DIR/sandbox/claude.version")"
BASE_IMAGE="uireact-base:$TOOLKIT_VERSION"
SANDBOX_IMAGE="$IMAGE_NAME:$SANDBOX_VERSION"

if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  ok "$BASE_IMAGE đã có sẵn — bỏ qua bước build."
else
  say "Đang build $BASE_IMAGE ($PLATFORM) — lần đầu mất vài phút..."
  docker build --platform "$PLATFORM" -t "$BASE_IMAGE" -t uireact-base:latest -f "$BUILDER_DIR/Dockerfile" "$BUILDER_DIR"
  ok "Đã build $BASE_IMAGE."
fi

if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  ok "$SANDBOX_IMAGE đã có sẵn — bỏ qua bước build."
else
  say "Đang build $SANDBOX_IMAGE ($PLATFORM)..."
  docker build --platform "$PLATFORM" \
    --build-arg TOOLKIT_VERSION="$TOOLKIT_VERSION" \
    --build-arg CLAUDE_CODE_VERSION="$CLAUDE_VERSION" \
    -t "$SANDBOX_IMAGE" -t "$IMAGE_NAME:latest" \
    -f "$BUILDER_DIR/sandbox/Dockerfile" "$BUILDER_DIR/sandbox"
  ok "Đã build $SANDBOX_IMAGE."
fi

docker volume create "$AUTH_VOLUME" >/dev/null

say "Đăng nhập Claude cho sandbox (trình duyệt sẽ mở ra, chỉ cần làm 1 lần)..."
docker run -it --rm -v "$AUTH_VOLUME:/home/node/.claude" "$SANDBOX_IMAGE" claude /login \
  || fail "Đăng nhập chưa xong. Chạy lại file này, hoặc tự chạy: docker run -it --rm -v $AUTH_VOLUME:/home/node/.claude $SANDBOX_IMAGE claude /login"

ok "Xong! Giờ mở app Open Design và đăng nhập bằng Google là dùng được."
read -rp "Nhấn Enter để đóng cửa sổ này..." _ || true
