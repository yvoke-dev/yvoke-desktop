// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceInput } from '../../src/renderer/src/components/VoiceInput';

type SpeechEventHandler = (event?: any) => void;

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = '';

  onstart: SpeechEventHandler | null = null;
  onend: SpeechEventHandler | null = null;
  onerror: SpeechEventHandler | null = null;
  onresult: SpeechEventHandler | null = null;

  start = vi.fn(() => {
    // triggers onstart asynchronously or synchronously
  });
  stop = vi.fn(() => {
    // triggers onend
  });
  abort = vi.fn(() => {
    // triggers onend or abort
  });

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }

  simulateStart(): void {
    if (this.onstart) {
      this.onstart();
    }
  }

  simulateEnd(): void {
    if (this.onend) {
      this.onend();
    }
  }

  simulateError(error: string, message?: string): void {
    if (this.onerror) {
      this.onerror({ error, message });
    }
  }

  simulateResult(transcript: string, isFinal = true): void {
    if (this.onresult) {
      this.onresult({
        resultIndex: 0,
        results: [
          Object.assign([{ transcript }], { isFinal }),
        ],
      });
    }
  }
}

describe('VoiceInput Component', () => {
  let originalSpeechRecognition: any;
  let originalWebkitSpeechRecognition: any;

  beforeEach(() => {
    MockSpeechRecognition.instances = [];
    originalSpeechRecognition = (window as any).SpeechRecognition;
    originalWebkitSpeechRecognition = (window as any).webkitSpeechRecognition;
    (window as any).SpeechRecognition = MockSpeechRecognition;
    (window as any).webkitSpeechRecognition = MockSpeechRecognition;
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    (window as any).SpeechRecognition = originalSpeechRecognition;
    (window as any).webkitSpeechRecognition = originalWebkitSpeechRecognition;
    vi.restoreAllMocks();
  });

  it('renders mic button and settings button', () => {
    render(<VoiceInput onTranscript={vi.fn()} />);
    expect(screen.getByRole('button', { name: /voice dictation/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /voice settings/i })).toBeDefined();
  });

  it('handles missing SpeechRecognition safely without crashing', () => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    render(<VoiceInput onTranscript={vi.fn()} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i }) as HTMLButtonElement;
    expect(micBtn.disabled).toBe(true);
    expect(micBtn.getAttribute('title')).toMatch(/not supported/i);
  });

  it('tap-to-record toggles and delivers speech chunks via onTranscript', () => {
    const onTranscript = vi.fn();
    const onRecordingChange = vi.fn();
    render(<VoiceInput onTranscript={onTranscript} onRecordingChange={onRecordingChange} />);

    const micBtn = screen.getByRole('button', { name: /voice dictation/i });
    fireEvent.click(micBtn);

    const recognition = MockSpeechRecognition.instances[0];
    expect(recognition.start).toHaveBeenCalledTimes(1);

    act(() => {
      recognition.simulateStart();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(true);
    expect(micBtn.classList.contains('recording')).toBe(true);

    act(() => {
      recognition.simulateResult('Hello world');
    });
    expect(onTranscript).toHaveBeenCalledWith('Hello world');

    // Tap again to stop
    fireEvent.click(micBtn);
    expect(recognition.stop).toHaveBeenCalledTimes(1);

    act(() => {
      recognition.simulateEnd();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(false);
    expect(micBtn.classList.contains('recording')).toBe(false);
  });

  it('prevents redundant start() calls when starting or recording and handles InvalidStateError', () => {
    render(<VoiceInput onTranscript={vi.fn()} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    expect(recognition.start).toHaveBeenCalledTimes(1);

    // Rapid second click while in 'starting' state
    fireEvent.click(micBtn);
    expect(recognition.start).toHaveBeenCalledTimes(1);

    act(() => {
      recognition.simulateEnd();
    });

    // If start() throws InvalidStateError, it should be caught cleanly
    class FailingRecognition extends MockSpeechRecognition {
      override start = vi.fn(() => {
        const err = new Error('recognition has already started');
        err.name = 'InvalidStateError';
        throw err;
      });
    }
    (window as any).SpeechRecognition = FailingRecognition;
    (window as any).webkitSpeechRecognition = FailingRecognition;

    // Next click attempts start, catches error, resets to idle
    act(() => {
      fireEvent.click(micBtn);
    });
    expect(micBtn.classList.contains('recording')).toBe(false);
    (window as any).SpeechRecognition = MockSpeechRecognition;
    (window as any).webkitSpeechRecognition = MockSpeechRecognition;
  });

  it('resets state cleanly when spontaneous onend fires (e.g. silence timeout)', () => {
    const onRecordingChange = vi.fn();
    render(<VoiceInput onTranscript={vi.fn()} onRecordingChange={onRecordingChange} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(true);

    // Spontaneous onend
    act(() => {
      recognition.simulateEnd();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(false);
    expect(micBtn.classList.contains('recording')).toBe(false);
  });

  it('safely handles aborted and no-speech error events without displaying error banners', () => {
    const onRecordingChange = vi.fn();
    render(<VoiceInput onTranscript={vi.fn()} onRecordingChange={onRecordingChange} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
    });

    // Simulate 'no-speech'
    act(() => {
      recognition.simulateError('no-speech');
      recognition.simulateEnd();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alert')).toBeNull();

    // Start again and simulate 'aborted'
    fireEvent.click(micBtn);
    act(() => {
      recognition.simulateStart();
      recognition.simulateError('aborted');
      recognition.simulateEnd();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('classifies audio-capture and not-allowed errors', () => {
    render(<VoiceInput onTranscript={vi.fn()} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
      recognition.simulateError('not-allowed');
      recognition.simulateEnd();
    });

    expect(screen.getByRole('alert').textContent).toMatch(/microphone access denied/i);

    // Start again and simulate 'audio-capture'
    fireEvent.click(micBtn);
    const recognition2 = MockSpeechRecognition.instances[1];
    act(() => {
      recognition2.simulateStart();
      recognition2.simulateError('audio-capture');
      recognition2.simulateEnd();
    });

    expect(screen.getByRole('alert').textContent).toMatch(/no microphone detected/i);
  });

  it('keyboard accessibility: Space/Enter toggles recording, Escape aborts', () => {
    render(<VoiceInput onTranscript={vi.fn()} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });
    const recognition = () => MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];

    // Space key to start
    fireEvent.keyDown(micBtn, { key: ' ' });
    expect(recognition().start).toHaveBeenCalled();
    act(() => {
      recognition().simulateStart();
    });

    // Escape key to abort
    fireEvent.keyDown(micBtn, { key: 'Escape' });
    expect(recognition().abort).toHaveBeenCalled();
    act(() => {
      recognition().simulateEnd();
    });
    expect(micBtn.classList.contains('recording')).toBe(false);

    // Enter key to start
    fireEvent.keyDown(micBtn, { key: 'Enter' });
    expect(recognition().start).toHaveBeenCalled();
  });

  it('unmounting while recording invokes recognition.abort() without state errors', () => {
    const { unmount } = render(<VoiceInput onTranscript={vi.fn()} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
    });

    unmount();
    expect(recognition.abort).toHaveBeenCalled();
  });

  it('respects disabled prop and ignores clicks and keydowns', () => {
    render(<VoiceInput onTranscript={vi.fn()} disabled={true} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i }) as HTMLButtonElement;

    expect(micBtn.disabled).toBe(true);
    fireEvent.click(micBtn);
    fireEvent.keyDown(micBtn, { key: 'Enter' });
    expect(MockSpeechRecognition.instances.length).toBe(0);
  });

  it('hold-to-record mode releases on window blur or external mouseup', () => {
    localStorage.setItem('yvoke_hold_to_record', 'true');
    render(<VoiceInput onTranscript={vi.fn()} />);

    const micBtn = screen.getByRole('button', { name: /voice dictation/i });
    const latestRecognition = () => MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];

    // MouseDown starts recording
    fireEvent.mouseDown(micBtn);
    expect(latestRecognition().start).toHaveBeenCalled();
    act(() => {
      latestRecognition().simulateStart();
    });

    // Window mouseup stops recording
    fireEvent(window, new MouseEvent('mouseup'));
    expect(latestRecognition().stop).toHaveBeenCalled();
    act(() => {
      latestRecognition().simulateEnd();
    });
    expect(micBtn.classList.contains('recording')).toBe(false);

    // MouseDown starts recording again
    fireEvent.mouseDown(micBtn);
    act(() => {
      latestRecognition().simulateStart();
    });

    // Window blur aborts recording
    fireEvent(window, new Event('blur'));
    expect(latestRecognition().abort).toHaveBeenCalled();
  });

  it('toggles hold-to-record preference and persists in localStorage', () => {
    render(<VoiceInput onTranscript={vi.fn()} />);
    const settingsBtn = screen.getByRole('button', { name: /voice settings/i });

    fireEvent.click(settingsBtn);
    const toggle = screen.getByRole('checkbox', { name: /hold to record/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(localStorage.getItem('yvoke_hold_to_record')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('yvoke_hold_to_record')).toBe('false');
  });

  it('ignores interim hypotheses (isFinal: false) and only emits final hypotheses (isFinal: true) to onTranscript', () => {
    const onTranscript = vi.fn();
    render(<VoiceInput onTranscript={onTranscript} />);
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });
    fireEvent.click(micBtn);

    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
    });

    // Interim hypothesis: isFinal = false -> MUST NOT be emitted
    act(() => {
      recognition.simulateResult('interim words', false);
    });
    expect(onTranscript).not.toHaveBeenCalled();

    // Final hypothesis: isFinal = true -> MUST be emitted
    act(() => {
      recognition.simulateResult('final words', true);
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('final words');
  });

  it('aborts active recording cleanly when disabled prop transitions to true', () => {
    const onRecordingChange = vi.fn();
    const { rerender } = render(
      <VoiceInput onTranscript={vi.fn()} onRecordingChange={onRecordingChange} disabled={false} />,
    );
    const micBtn = screen.getByRole('button', { name: /voice dictation/i });

    fireEvent.click(micBtn);
    const recognition = MockSpeechRecognition.instances[0];
    act(() => {
      recognition.simulateStart();
    });
    expect(onRecordingChange).toHaveBeenCalledWith(true);
    expect(micBtn.classList.contains('recording')).toBe(true);

    // Toggling disabled to true during active recording
    rerender(
      <VoiceInput onTranscript={vi.fn()} onRecordingChange={onRecordingChange} disabled={true} />,
    );

    expect(recognition.abort).toHaveBeenCalled();
    expect(onRecordingChange).toHaveBeenCalledWith(false);
    expect(micBtn.classList.contains('recording')).toBe(false);
  });
});

