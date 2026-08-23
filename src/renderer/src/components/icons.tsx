import React from 'react';

/*
 * One icon set for the whole app, replacing the emoji the design review flagged (🧠 📕 🔒 👍 ⚙️ …):
 * emoji render on their own coloured squares, which sit badly on a dark canvas and cannot take the
 * accent colour. These are Lucide outlines inlined as components rather than pulled from a package
 * — the app's CSP is `default-src 'self'` with no bundler-side icon step, and the repo already
 * hand-inlined the same paths in ThreadList.
 *
 * Every icon inherits `currentColor` and sizes from the `size` prop (default 16), so colour comes
 * from the surrounding token and never from the icon itself.
 */

export interface IconProps {
  size?: number;
  /** Extra stroke weight for the few places the design draws a heavier mark (buttons, checks). */
  strokeWidth?: number;
  className?: string;
}

function svg(
  paths: React.ReactNode,
  { size = 16, strokeWidth = 2, className }: IconProps,
  extra?: { fill?: string; linecap?: 'round' | 'square' },
): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={extra?.fill ?? 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap={extra?.linecap ?? 'round'}
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}

export const PlusIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="M12 5v14M5 12h14" />, { strokeWidth: 2.5, ...p }, { linecap: 'square' });

export const SearchIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.5-4.5" />
    </>,
    p,
  );

/**
 * A gear, not the circle-plus-rays the design mockup drew — at 16px that reads as a sun, which
 * is doubly wrong in an app that also has a light/dark control.
 */
export const SettingsIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p,
  );

export const LockIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <rect x="4" y="11" width="16" height="10" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
    { strokeWidth: 2, ...p },
    { linecap: 'square' },
  );

export const MoreIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </>,
    p,
  );

export const SendIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="M5 12h14M13 6l6 6-6 6" />, { strokeWidth: 2.5, ...p }, { linecap: 'square' });

export const CheckIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="m4 13 5 5L20 6" />, { strokeWidth: 3, ...p }, { linecap: 'square' });

export const TrashIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>,
    p,
  );

export const LogOutIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>,
    p,
  );

export const CloseIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="M18 6 6 18M6 6l12 12" />, p);

export const ChevronRightIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="m9 18 6-6-6-6" />, { strokeWidth: 2.5, ...p });

export const ChevronDownIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="m6 9 6 6 6-6" />, { strokeWidth: 2.5, ...p });

export const CopyIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <rect x="9" y="9" width="12" height="12" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>,
    p,
    { linecap: 'square' },
  );

export const ThumbsUpIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M7 22V10" />
      <path d="M14 3.5 12.6 9H19a2 2 0 0 1 1.94 2.5l-2.1 8A2 2 0 0 1 16.9 21H7V10h1.7a2 2 0 0 0 1.8-1.1L13 3.2a1 1 0 0 1 1 .3Z" />
      <path d="M3 10h4v12H3z" />
    </>,
    p,
  );

export const ThumbsDownIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M7 2v12" />
      <path d="M14 20.5 12.6 15H19a2 2 0 0 0 1.94-2.5l-2.1-8A2 2 0 0 0 16.9 3H7v11h1.7a2 2 0 0 1 1.8 1.1L13 20.8a1 1 0 0 0 1-.3Z" />
      <path d="M3 2h4v12H3z" />
    </>,
    p,
  );

export const AlertIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 9v5M12 17.5h.01" />
    </>,
    p,
  );

export const InfoIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>,
    p,
  );

export const HelpIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.6-2.7 2.6" />
      <path d="M12 17h.01" />
    </>,
    p,
  );

export const ThinkingIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M12 2.5 13.4 8 19 9.4 13.4 10.8 12 16.3 10.6 10.8 5 9.4 10.6 8Z" />
      <path d="M18 16.5 18.7 19 21 19.7 18.7 20.4 18 22.8 17.3 20.4 15 19.7 17.3 19Z" />
    </>,
    p,
  );

export const ToolIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M14.5 3.5a5 5 0 0 0 5.9 6.4l-8.9 8.9a2.6 2.6 0 0 1-3.7-3.7l8.9-8.9a5 5 0 0 0-2.2-2.7Z" />
    </>,
    p,
  );

export const CompassIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-2 6-6 2 2-6Z" />
    </>,
    p,
  );

export const ReviewerIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M12 3 5 5.5V11c0 4.4 2.9 7.6 7 9 4.1-1.4 7-4.6 7-9V5.5Z" />
      <path d="m9 12 2 2 4-4" />
    </>,
    p,
  );

export const SpecialistIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <path d="M14 3v5.2a2 2 0 0 0 .3 1l5 8.8A2 2 0 0 1 17.6 21H6.4a2 2 0 0 1-1.7-3l5-8.8a2 2 0 0 0 .3-1V3" />
      <path d="M9 3h6M7 15h10" />
    </>,
    p,
  );

export const PlaybookIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <rect x="8" y="2" width="8" height="4" />
      <path d="M16 4h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2" />
      <path d="M9 11h6M9 15h4" />
    </>,
    p,
    { linecap: 'square' },
  );

export const SunIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>,
    p,
  );

export const MoonIcon = (p: IconProps): React.JSX.Element =>
  svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />, p);

export const MonitorIcon = (p: IconProps): React.JSX.Element =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="12" />
      <path d="M8 20h8M12 16v4" />
    </>,
    p,
    { linecap: 'square' },
  );

export const StopIcon = (p: IconProps): React.JSX.Element =>
  svg(<rect x="6" y="6" width="12" height="12" />, p, { fill: 'currentColor' });
