/**
 * F-46 — OnboardingPage
 * 4-step flow: welcome → ds-select → api-key → done
 * Step progress dots + skip options + completeOnboarding()
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { DesignSystemPicker } from '../components/DesignSystemPicker';

const STEPS = ['welcome', 'ds-select', 'api-key', 'done'] as const;
type OnboardingStep = typeof STEPS[number];

export default function OnboardingPage() {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const { setSelectedDS, completeOnboarding } = useAppStore();
  const navigate = useNavigate();

  const handleDone = () => {
    completeOnboarding();
    navigate('/');
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: 'var(--color-bg)',
    }}>
      <div style={{ width: 480, padding: 40, textAlign: 'center' }}>
        {/* Step progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 32 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i <= STEPS.indexOf(step) ? 'var(--color-accent)' : 'var(--color-border)',
              transition: 'background 0.3s',
            }} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✦</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>
              Welcome to Open Design
            </h1>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28 }}>
              Your AI-powered design platform. Let's get you set up in a few steps.
            </p>
            <button
              id="onboarding-get-started"
              onClick={() => setStep('ds-select')}
              style={{ padding: '11px 32px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              Get Started →
            </button>
          </>
        )}

        {step === 'ds-select' && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>Choose a Design System</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
              Pick a design system to guide the AI's visual style.
            </p>
            <DesignSystemPicker
              onSelect={(id) => {
                if (id) setSelectedDS(id);
                setStep('api-key');
              }}
            />
            <button
              onClick={() => setStep('api-key')}
              style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Skip
            </button>
          </>
        )}

        {step === 'api-key' && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>Configure API Keys</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
              Add your AI provider API keys to enable generation features.
            </p>
            <button
              onClick={() => navigate('/settings?tab=api-keys')}
              style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', fontSize: 13, cursor: 'pointer', marginBottom: 12 }}
            >
              Open Settings →
            </button>
            <button
              onClick={() => setStep('done')}
              style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', margin: '0 auto' }}
            >
              Skip for now
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>You're all set!</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 28 }}>
              Start creating your first design project.
            </p>
            <button
              id="onboarding-done"
              onClick={handleDone}
              style={{ padding: '11px 32px', borderRadius: 10, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              Start Designing →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
