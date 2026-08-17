import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ConfluenceConfigResponse } from '../state/confluence-config';
import { saveConfluenceConfig, testConfluenceConnection } from '../state/confluence-config';
import { Icon } from './Icon';
import { PlModal } from './pipelines/PlModal';
import styles from './ConfluenceCredentialSection.module.css';

interface Props {
  initialToken?: string;
  replacing: boolean;
  tokenUrl: string | null;
  onClose: () => void;
  onSaved: (config: ConfluenceConfigResponse) => void;
}

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; ok: boolean; detail?: string; displayName?: string };

export function ConfluenceTokenEditModal({ initialToken = '', replacing, tokenUrl, onClose, onSaved }: Props) {
  const [token, setToken] = useState(initialToken);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const trimmedToken = token.trim();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const test = async () => {
    if (!trimmedToken || testState.status === 'running' || saving) return;
    setTestState({ status: 'running' });
    setError(null);
    const result = await testConfluenceConnection({ token: trimmedToken });
    setTestState({ status: 'done', ...result });
  };

  const save = async () => {
    if (!trimmedToken || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveConfluenceConfig({ token: trimmedToken });
      if (!result) {
        setError('Không thể lưu PAT. Vui lòng thử lại.');
        return;
      }
      onSaved(result);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <PlModal
      title={replacing ? 'Thay đổi Confluence PAT' : 'Thiết lập Confluence PAT'}
      icon="edit"
      size="md"
      busy={saving}
      onClose={onClose}
      bodyClassName={styles.editModalBody}
      footer={(
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={saving}>Hủy</button>
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            disabled={!trimmedToken || saving}
            onClick={() => void save()}
            data-testid="confluence-token-modal-save"
          >
            <Icon name={saving ? 'spinner' : 'check'} size={14} className={saving ? 'icon-spin' : ''} />
            {saving ? 'Đang lưu…' : 'Lưu PAT'}
          </button>
        </>
      )}
    >
      <div className={styles.editModalContent}>
        <div className={styles.securityNote}>
          <Icon name="info" size={17} />
          <div>
            <strong>{replacing ? 'PAT hiện tại vẫn hoạt động cho đến khi bạn lưu PAT mới.' : 'PAT chỉ được lưu trên máy này.'}</strong>
            <p>Open Design không hiển thị lại hoặc gửi PAT đã lưu về trình duyệt.</p>
          </div>
        </div>

        <label className={styles.tokenField}>
          <span>Personal Access Token mới</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="Dán PAT từ Confluence"
            onChange={(event) => {
              setToken(event.target.value);
              setTestState({ status: 'idle' });
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmedToken && !saving) {
                event.preventDefault();
                void save();
              }
            }}
            data-testid="confluence-token-modal-input"
          />
        </label>

        <div className={styles.modalActionsRow}>
          <button
            type="button"
            className="pl-btn"
            disabled={!trimmedToken || saving || testState.status === 'running'}
            onClick={() => void test()}
            data-testid="confluence-token-modal-test"
          >
            <Icon
              name={testState.status === 'running' ? 'spinner' : 'reload'}
              size={14}
              className={testState.status === 'running' ? 'icon-spin' : ''}
            />
            {testState.status === 'running' ? 'Đang kiểm tra…' : 'Kiểm tra PAT mới'}
          </button>
          {tokenUrl ? (
            <a href={tokenUrl} target="_blank" rel="noreferrer">
              Tạo PAT trên Confluence <Icon name="external-link" size={12} />
            </a>
          ) : null}
        </div>

        {testState.status === 'done' ? (
          <div className={testState.ok ? styles.testSuccess : styles.testError} role={testState.ok ? 'status' : 'alert'}>
            <Icon name={testState.ok ? 'check' : 'info'} size={15} />
            <span>
              {testState.ok
                ? testState.displayName
                  ? `Kết nối thành công với tài khoản ${testState.displayName}.`
                  : 'Kết nối Confluence thành công.'
                : testState.detail || 'Không thể kết nối bằng PAT này.'}
            </span>
          </div>
        ) : null}
        {error ? <div className={styles.testError} role="alert"><Icon name="info" size={15} />{error}</div> : null}
      </div>
    </PlModal>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
