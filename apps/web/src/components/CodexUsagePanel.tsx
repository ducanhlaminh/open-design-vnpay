// Codex CLI deliberately exposes login state but not the ChatGPT subscription
// quota / reset windows. Keep this explicit in the product rather than showing
// an invented percentage based on token events from individual chat turns.
import { Icon } from './Icon';

export function CodexUsagePanel(): JSX.Element {
  return (
    <div className="claude-usage-section" data-testid="codex-usage-panel">
      <div className="claude-usage-section__head">
        <Icon name="sliders" size={14} />
        <span>Mức dùng tài khoản Codex</span>
      </div>
      <p className="claude-usage-section__note">
        Codex CLI chưa cung cấp API quota hoặc thời điểm reset cho app cục bộ. Open Design
        không ước lượng phần trăm để tránh hiển thị sai; token của từng lượt chạy vẫn hiện
        trong chi tiết tin nhắn khi runtime trả về.
      </p>
    </div>
  );
}
