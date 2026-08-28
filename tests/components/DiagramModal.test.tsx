// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiagramModal } from '../../src/renderer/src/components/DiagramModal';

afterEach(() => {
  cleanup();
});

describe('DiagramModal', () => {
  const sampleSvg = '<svg class="sample-diagram"><g id="node1"><text>Test Node</text></g></svg>';
  const sampleChart = 'flowchart TD\n  A --> B';

  it('renders modal with title, hint, zoom controls, and SVG content', () => {
    const onClose = vi.fn();
    render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Diagram preview' })).toBeTruthy();
    expect(screen.getByText('Diagram Preview')).toBeTruthy();
    expect(screen.getByText(/Drag with mouse/)).toBeTruthy();
    expect(screen.getByText('140%')).toBeTruthy(); // default scale
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset zoom and position' })).toBeTruthy();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: 'Close modal' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking overlay background', () => {
    const onClose = vi.fn();
    render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    const overlay = screen.getByRole('dialog', { name: 'Diagram preview' });
    // A real click always delivers mousedown first; the overlay's dismiss depends on it.
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when a pan drag releases past the modal edge', () => {
    const onClose = vi.fn();
    const { container } = render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);
    const overlay = screen.getByRole('dialog', { name: 'Diagram preview' });
    const body = container.querySelector('.diagram-lightbox-body') as HTMLElement;

    // Press on the canvas, release outside the modal: the browser dispatches the resulting
    // `click` on the nearest common ancestor, which is the overlay.
    fireEvent.mouseDown(body, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(window);
    fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('adjusts zoom level with zoom in and zoom out buttons', () => {
    const onClose = vi.fn();
    render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    const zoomInBtn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOutBtn = screen.getByRole('button', { name: 'Zoom out' });

    expect(screen.getByText('140%')).toBeTruthy();

    fireEvent.click(zoomInBtn);
    expect(screen.getByText('160%')).toBeTruthy();

    fireEvent.click(zoomOutBtn);
    expect(screen.getByText('140%')).toBeTruthy();
  });

  it('resets zoom and pan when reset button is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    const zoomInBtn = screen.getByRole('button', { name: 'Zoom in' });
    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomInBtn);
    expect(screen.getByText('180%')).toBeTruthy();

    // Pan with arrow key
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    const resetBtn = screen.getByRole('button', { name: 'Reset zoom and position' });
    fireEvent.click(resetBtn);

    expect(screen.getByText('140%')).toBeTruthy();
    const viewport = container.querySelector('.diagram-lightbox-viewport') as HTMLElement;
    expect(viewport.style.transform).toBe('translate(0px, 0px) scale(1.4)');
  });

  it('supports arrow keys for panning around the diagram', () => {
    const onClose = vi.fn();
    const { container } = render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);
    const viewport = container.querySelector('.diagram-lightbox-viewport') as HTMLElement;

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(viewport.style.transform).toContain('translate(50px, 0px)');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(viewport.style.transform).toContain('translate(50px, -50px)');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(viewport.style.transform).toContain('translate(0px, -50px)');

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(viewport.style.transform).toContain('translate(0px, 0px)');
  });

  it('supports keyboard zoom keys (+, -, 0)', () => {
    const onClose = vi.fn();
    render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);

    fireEvent.keyDown(window, { key: '+' });
    expect(screen.getByText('160%')).toBeTruthy();

    fireEvent.keyDown(window, { key: '-' });
    expect(screen.getByText('140%')).toBeTruthy();

    fireEvent.keyDown(window, { key: '+' });
    fireEvent.keyDown(window, { key: '+' });
    expect(screen.getByText('180%')).toBeTruthy();

    fireEvent.keyDown(window, { key: '0' });
    expect(screen.getByText('140%')).toBeTruthy();
  });

  it('supports mouse drag panning', () => {
    const onClose = vi.fn();
    const { container } = render(<DiagramModal svg={sampleSvg} chart={sampleChart} onClose={onClose} />);
    const body = container.querySelector('.diagram-lightbox-body') as HTMLElement;
    const viewport = container.querySelector('.diagram-lightbox-viewport') as HTMLElement;

    fireEvent.mouseDown(body, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 180 });
    fireEvent.mouseUp(window);

    expect(viewport.style.transform).toBe('translate(50px, 80px) scale(1.4)');
  });
});
