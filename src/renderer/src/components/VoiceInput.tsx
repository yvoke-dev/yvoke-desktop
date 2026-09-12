import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, MicIcon } from './icons';

type VoiceState = 'idle' | 'starting' | 'recording' | 'stopping';

export interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang?: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export interface VoiceInputProps {
  onTranscript: (chunk: string) => void;
  onRecordingChange?: (isRecording: boolean) => void;
  disabled?: boolean;
}

const STORAGE_KEY_HOLD_TO_RECORD = 'yvoke_hold_to_record';

export function VoiceInput({
  onTranscript,
  onRecordingChange,
  disabled = false,
}: VoiceInputProps): React.JSX.Element {
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [holdToRecord, setHoldToRecord] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_HOLD_TO_RECORD) === 'true';
    } catch {
      return false;
    }
  });

  const stateRef = useRef<VoiceState>('idle');
  stateRef.current = state;

  const holdToRecordRef = useRef(holdToRecord);
  holdToRecordRef.current = holdToRecord;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isMountedRef = useRef(true);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isSupported =
    typeof window !== 'undefined' &&
    !!((window as unknown as SpeechRecognitionWindow).SpeechRecognition ||
      (window as unknown as SpeechRecognitionWindow).webkitSpeechRecognition);

  const getSpeechRecognitionClass = useCallback((): SpeechRecognitionConstructor | null => {
    if (typeof window === 'undefined') return null;
    const win = window as unknown as SpeechRecognitionWindow;
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
  }, []);

  const stopRecording = useCallback(() => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'starting') {
      return;
    }
    stateRef.current = 'stopping';
    if (isMountedRef.current) {
      setState('stopping');
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // In case stop fails or recognition already ended
      stateRef.current = 'idle';
      if (isMountedRef.current) {
        setState('idle');
        onRecordingChange?.(false);
      }
    }
  }, [onRecordingChange]);

  const abortRecording = useCallback(() => {
    stateRef.current = 'idle';
    if (isMountedRef.current) {
      setState('idle');
      onRecordingChange?.(false);
    }
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }
  }, [onRecordingChange]);

  const startRecording = useCallback(() => {
    if (disabled || !isSupported) return;
    if (stateRef.current !== 'idle') return;

    const SpeechClass = getSpeechRecognitionClass();
    if (!SpeechClass) return;

    if (isMountedRef.current) {
      setErrorMessage(null);
    }

    stateRef.current = 'starting';
    setState('starting');

    let recognition: SpeechRecognitionInstance;
    try {
      recognition = new SpeechClass();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        if (!isMountedRef.current) {
          try {
            recognition.abort();
          } catch {
            // ignore
          }
          return;
        }
        stateRef.current = 'recording';
        setState('recording');
        onRecordingChange?.(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        if (!isMountedRef.current) return;
        let finalChunk = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res?.isFinal && res[0]?.transcript) {
            finalChunk += res[0].transcript;
          }
        }
        if (finalChunk) {
          onTranscript(finalChunk);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (!isMountedRef.current) return;
        stateRef.current = 'idle';
        setState('idle');
        onRecordingChange?.(false);

        if (event.error === 'no-speech' || event.error === 'aborted') {
          // Harmless error filtering: silence or cancellation
          return;
        }

        if (event.error === 'not-allowed') {
          setErrorMessage('Microphone access denied. Please grant microphone permissions.');
        } else if (event.error === 'audio-capture') {
          setErrorMessage('No microphone detected. Please check your audio hardware.');
        }
      };

      recognition.onend = () => {
        if (!isMountedRef.current) return;
        stateRef.current = 'idle';
        setState('idle');
        onRecordingChange?.(false);
      };

      recognition.start();
    } catch {
      // InvalidStateError or initialization failure
      stateRef.current = 'idle';
      if (isMountedRef.current) {
        setState('idle');
        onRecordingChange?.(false);
      }
    }
  }, [disabled, isSupported, getSpeechRecognitionClass, onRecordingChange, onTranscript]);

  // Abort recording if disabled becomes true while active
  useEffect(() => {
    if (disabled && (state === 'recording' || state === 'starting')) {
      abortRecording();
    }
  }, [disabled, state, abortRecording]);

  // Window-level mouseup and blur listeners during hold-to-record
  useEffect(() => {
    if (!holdToRecord || (state !== 'recording' && state !== 'starting')) {
      return;
    }

    const handleWindowMouseUp = (): void => {
      stopRecording();
    };

    const handleWindowBlur = (): void => {
      abortRecording();
    };

    window.addEventListener('mouseup', handleWindowMouseUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('mouseup', handleWindowMouseUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [holdToRecord, state, stopRecording, abortRecording]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!showSettings) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setShowSettings(false);
      }
    };

    const handleMouseDown = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [showSettings]);

  const handleToggleHoldToRecord = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.checked;
    setHoldToRecord(next);
    try {
      localStorage.setItem(STORAGE_KEY_HOLD_TO_RECORD, String(next));
    } catch {
      // ignore
    }
  };

  const handleButtonClick = (): void => {
    if (disabled || !isSupported) return;
    if (holdToRecord) return; // In hold-to-record mode, mousedown/mouseup handles recording

    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
  };

  const handleButtonMouseDown = (): void => {
    if (disabled || !isSupported || !holdToRecord) return;
    if (state === 'idle') {
      startRecording();
    }
  };

  const handleButtonMouseUp = (): void => {
    if (disabled || !isSupported || !holdToRecord) return;
    if (state === 'recording' || state === 'starting') {
      stopRecording();
    }
  };

  const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || !isSupported) return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state === 'idle') {
        startRecording();
      } else if (state === 'recording') {
        stopRecording();
      }
    } else if (e.key === 'Escape') {
      if (state === 'recording' || state === 'starting') {
        e.preventDefault();
        abortRecording();
      }
    }
  };

  const isRecording = state === 'recording' || state === 'starting';

  return (
    <div className="composer-voice-group">
      {errorMessage && (
        <div role="alert" className="voice-error-banner">
          <span>{errorMessage}</span>
          <button
            type="button"
            className="voice-error-dismiss"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <button
        type="button"
        className={`composer-voice-btn ${isRecording ? 'recording' : ''}`}
        aria-label="Voice dictation"
        title={
          !isSupported
            ? 'Voice dictation not supported in this environment'
            : isRecording
              ? 'Stop recording'
              : 'Start voice dictation'
        }
        disabled={disabled || !isSupported}
        onClick={handleButtonClick}
        onMouseDown={handleButtonMouseDown}
        onMouseUp={handleButtonMouseUp}
        onKeyDown={handleButtonKeyDown}
      >
        <MicIcon size={14} />
      </button>
      <button
        type="button"
        className="composer-voice-chevron"
        aria-label="Voice settings"
        title="Voice settings"
        disabled={disabled}
        onClick={() => setShowSettings((prev) => !prev)}
      >
        <ChevronDownIcon size={10} />
      </button>
      {showSettings && (
        <div className="voice-settings-dropdown" ref={dropdownRef}>
          <label className="voice-switch-label">
            <span>Hold to record</span>
            <input
              type="checkbox"
              className="voice-switch"
              aria-label="Hold to record"
              checked={holdToRecord}
              onChange={handleToggleHoldToRecord}
            />
          </label>
        </div>
      )}
    </div>
  );
}
