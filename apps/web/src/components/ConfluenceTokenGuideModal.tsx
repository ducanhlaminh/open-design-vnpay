import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const modal = (
    <PlModal
      title="Hướng dẫn lấy Confluence Access Token"
      icon="info"
      size="xl"
      bodyClassName={styles.modalBody}
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
              <figure className={styles.guideImage}>
                <img
                  src="/guides/confluence-token/step-1-create-token.svg"
                  alt="Trang Personal Access Tokens với nút Create token ở góc phải được khoanh đỏ"
                />
                <figcaption>Bấm <b>Create token</b> ở góc phải.</figcaption>
              </figure>
            </div>
          </li>

          <li className={styles.step}>
            <span className={styles.number}>2</span>
            <div className={styles.stepBody}>
              <strong>Đặt tên và tạo token</strong>
              <p>Nhập tên dễ nhớ, ví dụ <b>Open Design</b>. Có thể để token không hết hạn hoặc chọn ngày hết hạn theo quy định của đơn vị.</p>
              <figure className={styles.guideImage}>
                <img
                  src="/guides/confluence-token/step-2-configure-token.svg"
                  alt="Form tạo Personal Access Token với ô Token Name và tùy chọn Automatic expiry được đánh dấu đỏ"
                />
                <figcaption>Điền tên token, chọn thời hạn nếu cần rồi bấm <b>Create</b>.</figcaption>
              </figure>
            </div>
          </li>

          <li className={styles.step}>
            <span className={styles.number}>3</span>
            <div className={styles.stepBody}>
              <strong>Sao chép token ngay khi Confluence hiển thị</strong>
              <p>Bấm biểu tượng sao chép trước khi bấm <b>Close</b>. Sau khi đóng, Confluence sẽ không hiển thị lại token này.</p>
              <figure className={styles.guideImage}>
                <img
                  src="/guides/confluence-token/step-3-copy-token.svg"
                  alt="Token mới tạo và nút sao chép được đánh dấu đỏ"
                />
                <figcaption>Sao chép token trước khi bấm <b>Close</b>.</figcaption>
              </figure>
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

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
