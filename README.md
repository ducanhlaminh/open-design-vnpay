# VNPAY Design Platform

Nền tảng thiết kế sản phẩm nội bộ của VNPAY: biến tài liệu nghiệp vụ thành UX spec, wireframe, luồng màn hình, prototype tương tác và giao diện hoàn chỉnh — bằng AI agent chạy ngay trên máy của bạn.

Ứng dụng gồm một web app + daemon chạy local trong một tiến trình Node.js duy nhất. **Không cần Docker, không cần quyền admin.** Engine thiết kế là Claude Code CLI (mặc định, bắt buộc) và Codex CLI (tùy chọn) đã đăng nhập sẵn trên máy.

## Tính năng chính

- **Pipeline tài liệu → giao diện** — chọn App/Feature, nạp tài liệu nghiệp vụ (BAS/Confluence), chạy lần lượt các bước: Customer Journey → UX spec → wireframe & flow → prototype React → UI.
- **Canvas màn hình** — xem toàn bộ màn hình và luồng chuyển màn trên canvas; mở wireframe, flow, prototype của từng màn.
- **Prototype thật** — prototype là code React chạy được, kèm simulator bấm thử luồng ngay trong app.
- **Copy sang Figma** — copy thiết kế rồi paste thẳng vào Figma, giữ layout và style.
- **Đồng bộ dự án (KG sync)** — dự án chia sẻ giữa các máy qua Knowledge Graph service; đăng nhập Google để ghi nhận người thực hiện và nhận dự án được chia sẻ.
- **Tự cập nhật** — app tự kiểm tra và cập nhật phiên bản mới từ GitHub Releases (hoặc chạy lại installer với `--update`).

## Yêu cầu máy

| Hệ điều hành | Hỗ trợ |
| --- | --- |
| macOS | Apple Silicon (arm64) hoặc Intel (x64) |
| Linux | x64 |
| Windows | Windows 10 1803+ / Windows 11 (64-bit), PowerShell 5.1+ |

- **Không cần cài trước bất cứ gì** — installer tự tải Node.js nếu máy chưa có, tự cài Claude Code CLI và Codex CLI nếu thiếu.
- Không dùng `sudo`/quyền admin ở bất kỳ bước nào; mọi thứ nằm trong thư mục người dùng (`~/.open-design`, dữ liệu ở `~/od-data/open-design`).
- Mạng cần truy cập được: `github.com`, `nodejs.org` (khi thiếu Node), `claude.ai` / `chatgpt.com` (khi thiếu CLI). Installer kiểm tra trước khi cài và báo đúng domain bị chặn nếu công ty có firewall/proxy.
- Tài khoản Claude (bắt buộc) và tài khoản ChatGPT/Codex (tùy chọn) để đăng nhập CLI.

## Hướng dẫn cài đặt

### macOS / Linux

Mở Terminal, chạy 2 lệnh:

```bash
curl -fsSL https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.sh -o install.sh
bash install.sh
```

### Windows

Mở PowerShell, chạy:

```powershell
irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1 | iex
```

Nếu muốn tải script về xem trước rồi mới chạy:

```powershell
irm https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Installer sẽ tự làm 6 bước

1. **Kiểm tra gói cài đặt** — tải bản phát hành mới nhất, xác minh checksum trước khi giải nén.
2. **Kiểm tra Node.js** — dùng Node có sẵn nếu hợp phiên bản, không thì tự tải bản riêng.
3. **Giải nén & cài đặt** — cài vào `~/.open-design/releases/<version>`, ghi cấu hình.
4. **Cấu hình dịch vụ** — đăng ký chạy nền tự khởi động cùng máy (launchd trên macOS, systemd trên Linux, Task Scheduler trên Windows).
5. **Khởi động & kiểm tra sức khỏe** — nếu lỗi sẽ tự rollback về bản trước.
6. **Kiểm tra Claude & Codex CLI** — tự cài CLI nếu thiếu và báo trạng thái đăng nhập.

Cấu hình KG sync và đăng nhập Google đã được đóng gói sẵn trong bản phát hành của repo này — cài **không cần truyền flag nào** là dùng được ngay.

### Sau khi cài xong

1. Mở trình duyệt vào **http://127.0.0.1:7456**.
2. Nếu installer in ra *"còn một bước: `claude /login`"* — mở Terminal, chạy `claude` rồi gõ `/login` và đăng nhập theo hướng dẫn (tương tự `codex login` nếu bạn dùng Codex).
3. Vào **Cài đặt → Execution** trong app để xem trạng thái: card Claude/Codex hiển thị đã đăng nhập bằng tài khoản nào, kèm nút **Đăng xuất** / **Kiểm tra lại**.

### Cập nhật

Cách 1 — ngay trong app: khi có bản mới, app hiện thông báo cập nhật, bấm là xong.

Cách 2 — bằng lệnh:

```bash
# macOS / Linux
bash ~/.open-design/current/install.sh --update
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.open-design\current\install.ps1 -Update
```

### Gỡ cài đặt, rollback, flags nâng cao

Xem [deploy/host/README.md](deploy/host/README.md) — tài liệu đầy đủ về mọi flag cài đặt, cấu hình `config.env`, rollback thủ công và gỡ cài đặt từng nền tảng.

## Chế độ thực thi

App chạy ở chế độ **Host CLI**: mọi tác vụ AI chạy trực tiếp bằng Claude/Codex CLI đã đăng nhập trên máy. Docker sandbox hiện **tạm khóa** (dev có thể bật lại bằng biến môi trường `OD_SANDBOX=1` khi cần).

## Dành cho developer

```bash
git clone git@github.com:ducanhlaminh/open-design-vnpay.git
cd open-design-vnpay
pnpm install
pnpm tools-dev   # daemon + web dev server, địa chỉ in ra terminal
```

- Typecheck: `pnpm typecheck` (hoặc `npx tsc --noEmit` trong từng package).
- Test: `npx vitest run` trong `apps/daemon`, `apps/web`, …
- Hướng dẫn cho agent/codebase: [AGENTS.md](AGENTS.md). Build & phát hành host runtime: [deploy/host/README.md](deploy/host/README.md).

## Tài liệu

- [Hướng dẫn sử dụng (tiếng Việt)](docs/guides/open-design-user-guide-vi.md)
- [Cài đặt & vận hành host runtime](deploy/host/README.md)
- [Kiến trúc](docs/architecture.md) · [Spec](docs/spec.md) · [Skills protocol](docs/skills-protocol.md)

## Nguồn gốc & giấy phép

VNPAY Design Platform được phát triển trên nền [Open Design](https://github.com/nexu-io/open-design) (mã nguồn mở, Apache 2.0) và tùy biến sâu cho quy trình thiết kế sản phẩm của VNPAY. Xem [LICENSE](LICENSE).
