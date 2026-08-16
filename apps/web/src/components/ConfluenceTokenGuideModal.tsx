import { useState } from 'react';

import { Icon } from './Icon';
import { PlModal } from './pipelines/PlModal';
import styles from './ConfluenceTokenGuideModal.module.css';

interface Props {
  tokenUrl: string;
  onClose: () => void;
  onUseToken: (token: string) => void;
}

export function ConfluenceTokenGuideModal({ tokenUrl, onClose, onUseToken }: Props) {
  const [token, setToken] = useState('');
  const trimmedToken = token.trim();

  return (
    <PlModal
      title="Hướng dẫn lấy Confluence Access Token"
      icon="info"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <span className={styles.footerHint}>Token chỉ được lưu trên máy đang chạy Open Design.</span>
          <button type="button" className="pl-btn" onClick={onClose}>Đóng</button>
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            disabled={!trimmedToken}
            onClick={() => onUseToken(trimmedToken)}
          >
            <Icon name="check" size={14} /> Dùng token này
          </button>
        </>
      )}
    >
      <div className={styles.guide}>
        <div className={styles.intro}>
          <Icon name="info" size={18} />
          <div>
            <strong>Làm lần lượt 3 bước dưới đây</strong>
            <p>Không gửi token qua chat hoặc email. Confluence chỉ hiển thị token một lần sau khi tạo.</p>
          </div>
        </div>

        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.number}>1</span>
            <div className={styles.stepBody}>
              <div className={styles.stepTitle}>
                <div><strong>Mở trang Personal Access Tokens</strong><p>Trong Confluence: ảnh đại diện → Settings → Personal Access Tokens.</p></div>
                <a className={styles.openButton} href={tokenUrl} target="_blank" rel="noreferrer">
                  Mở trang tạo token <Icon name="external-link" size={13} />
                </a>
              </div>
              <div className={styles.mockScreen} aria-label="Minh họa nút Create token">
                <span>Personal Access Tokens</span>
                <span className={styles.mockPrimary}>Create token</span>
              </div>
              <p className={styles.instruction}>Bấm <b>Create token</b> ở góc phải.</p>
            </div>
          </li>

          <li className={styles.step}>
            <span className={styles.number}>2</span>
            <div className={styles.stepBody}>
              <strong>Đặt tên và tạo token</strong>
              <p>Nhập tên dễ nhớ, ví dụ <b>Open Design</b>. Có thể để token không hết hạn hoặc chọn ngày hết hạn theo quy định của đơn vị.</p>
              <div className={styles.mockForm} aria-label="Minh họa form tạo token">
                <label><span>Token Name</span><span className={styles.mockInput}>Open Design</span></label>
                <span className={styles.mockCheck}>□ Automatic expiry</span>
                <span className={styles.mockPrimary}>Create</span>
              </div>
            </div>
          </li>

          <li className={styles.step}>
            <span className={styles.number}>3</span>
            <div className={styles.stepBody}>
              <strong>Sao chép token ngay khi Confluence hiển thị</strong>
              <p>Bấm biểu tượng sao chép trước khi bấm <b>Close</b>. Sau khi đóng, Confluence sẽ không hiển thị lại token này.</p>
              <div className={styles.mockToken} aria-label="Minh họa sao chép token">
                <span>••••••••••••••••••••••••</span><Icon name="copy" size={15} />
              </div>
            </div>
          </li>
        </ol>

        <label className={styles.pasteBox}>
          <span><b>Dán token vào đây</b><small>Bạn có thể dán ngay trong hướng dẫn rồi bấm “Dùng token này”.</small></span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="Dán Personal Access Token vừa sao chép"
            onChange={(event) => setToken(event.target.value)}
            autoFocus
          />
        </label>
      </div>
    </PlModal>
  );
}
