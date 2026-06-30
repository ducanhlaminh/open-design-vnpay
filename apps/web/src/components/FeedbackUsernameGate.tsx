import { useState } from 'react';
import styles from './FeedbackUsernameGate.module.css';

interface Props {
  /** Called with the trimmed, non-empty username. The host persists it to
   *  app config (feedbackUsername), which dismisses the gate. */
  onSubmit: (username: string) => void;
}

/**
 * Mandatory first-use gate: blocks the whole app until the user enters a
 * display name. The name is stamped on every feedback prompt this install
 * ships to the shared store, so the cross-user feedback digest can attribute
 * each prompt to a person. There is no dismiss action on purpose — the gate
 * stays mounted until a non-empty name is saved (it can be changed later in
 * Settings → Feedback username).
 */
export function FeedbackUsernameGate({ onSubmit }: Props): JSX.Element {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const submit = (): void => {
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-username-gate-title"
    >
      <div className={styles.card}>
        <span className={styles.kicker}>VNPAY Design Platform</span>
        <h2 id="feedback-username-gate-title" className={styles.title}>
          Nhập tên của bạn để tiếp tục
        </h2>
        <p className={styles.desc}>
          Tên này được gắn vào các phản hồi bạn gửi để nhóm tổng hợp đúng người.
          Bạn có thể đổi lại sau trong Settings → Feedback username.
        </p>
        <input
          className={styles.input}
          type="text"
          autoFocus
          maxLength={120}
          placeholder="ví dụ: anhnd"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={!trimmed}
          onClick={submit}
        >
          Tiếp tục
        </button>
      </div>
    </div>
  );
}
