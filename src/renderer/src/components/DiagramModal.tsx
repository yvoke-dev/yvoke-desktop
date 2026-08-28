import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from './icons';
import { CopyButton, CopyImageButton, copySvgAsPng } from './CopyButton';

export interface DiagramModalProps {
  svg: string;
  chart: string;
  onClose: () => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5.0;
const INITIAL_SCALE = 1.4;

export function DiagramModal({ svg, chart, onClose }: DiagramModalProps): React.JSX.Element {
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  /**
   * A drag that starts on the canvas and releases past the modal's edge dispatches its `click` on
   * the nearest common ancestor — the overlay — which would read as a click-outside and dismiss
   * the diagram mid-pan. The overlay only closes for a press that also began on it.
   */
  const overlayPressRef = useRef(false);

  const handleZoom = useCallback((delta: number) => {
    setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((prev + delta) * 100) / 100)));
  }, []);

  const handleReset = useCallback(() => {
    setScale(INITIAL_SCALE);
    setPan({ x: 0, y: 0 });
  }, []);

  // Keyboard navigation: Escape to close, arrows to pan, +/- to zoom, 0 to reset
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPan((prev) => ({ ...prev, y: prev.y + 50 }));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPan((prev) => ({ ...prev, y: prev.y - 50 }));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPan((prev) => ({ ...prev, x: prev.x + 50 }));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPan((prev) => ({ ...prev, x: prev.x - 50 }));
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoom(0.2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleZoom(-0.2);
      } else if (e.key === '0' || e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleReset();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handleZoom, handleReset]);

  // Mouse dragging
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Only drag on primary mouse button
    if (e.button !== 0) return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPan({
        x: dragRef.current.panX + dx,
        y: dragRef.current.panY + dy,
      });
    };

    const handleMouseUp = (): void => {
      dragRef.current = null;
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Wheel zoom and pan. React registers `wheel` on the root container as a *passive* listener,
  // which makes preventDefault() inside an onWheel prop a silent no-op (Chromium logs an
  // intervention warning for each one), so the listener is attached natively instead.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        handleZoom(e.deltaY < 0 ? 0.15 : -0.15);
      } else {
        setPan((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
      }
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [handleZoom]);

  return (
    <div
      className="diagram-lightbox-overlay"
      onMouseDown={(e) => {
        overlayPressRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && overlayPressRef.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Diagram preview"
    >
      <div className="diagram-lightbox-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diagram-lightbox-header">
          <div className="diagram-lightbox-title">
            <span>Diagram Preview</span>
            <span className="diagram-lightbox-hint">Drag with mouse • Arrow keys • Wheel / +/− to zoom</span>
          </div>

          <div className="diagram-lightbox-controls">
            <div className="diagram-zoom-cluster">
              <button
                type="button"
                className="diagram-lightbox-btn"
                onClick={() => handleZoom(-0.2)}
                title="Zoom out (-)"
                aria-label="Zoom out"
                disabled={scale <= MIN_SCALE}
              >
                <ZoomOutIcon size={14} />
              </button>
              <span className="diagram-zoom-badge">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                className="diagram-lightbox-btn"
                onClick={() => handleZoom(0.2)}
                title="Zoom in (+)"
                aria-label="Zoom in"
                disabled={scale >= MAX_SCALE}
              >
                <ZoomInIcon size={14} />
              </button>
              <button
                type="button"
                className="diagram-lightbox-btn"
                onClick={handleReset}
                title="Reset zoom & position (0 or R)"
                aria-label="Reset zoom and position"
              >
                <RotateCcwIcon size={13} />
                <span>Reset</span>
              </button>
            </div>

            <div className="diagram-action-cluster">
              <CopyButton text={chart} tip="Copy Mermaid source" />
              <CopyImageButton onCopy={() => copySvgAsPng(containerRef.current, svg)} tip="Copy diagram as image" />
            </div>

            <button
              type="button"
              className="lightbox-close-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close modal"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        </div>

        <div
          ref={bodyRef}
          className={`diagram-lightbox-body ${isDragging ? 'is-dragging' : ''}`}
          onMouseDown={handleMouseDown}
        >
          <div
            ref={containerRef}
            className="diagram-lightbox-viewport"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: 'center center',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
