import type { Session } from 'electron';

export interface PermissionRequestDetails {
  mediaTypes?: string[];
  isMainFrame?: boolean;
  requestingUrl?: string;
}

export interface PermissionCheckDetails {
  mediaType?: string;
  isMainFrame?: boolean;
}

const UNTRUSTED_SCHEMES = ['blob:', 'javascript:', 'data:', 'about:'];

/**
 * Validates a media permission request from `session.setPermissionRequestHandler`.
 * Account for Electron signature: `details.mediaTypes?: string[]` (array).
 * Strictly requires audio-only, main frame, valid scheme, and origin matching expected app origin.
 */
export function validatePermissionRequest(
  permission: string,
  details: PermissionRequestDetails | undefined,
  expectedOrigin: string,
): boolean {
  if (permission !== 'media') {
    return false;
  }
  if (!details || details.isMainFrame === false) {
    return false;
  }
  if (
    !details.mediaTypes ||
    !Array.isArray(details.mediaTypes) ||
    details.mediaTypes.length === 0 ||
    !details.mediaTypes.every((type) => type === 'audio')
  ) {
    return false;
  }
  if (!details.requestingUrl || typeof details.requestingUrl !== 'string') {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(details.requestingUrl);
  } catch {
    return false;
  }

  if (UNTRUSTED_SCHEMES.includes(parsed.protocol)) {
    return false;
  }

  if (!expectedOrigin || parsed.origin !== expectedOrigin) {
    return false;
  }

  return true;
}

/**
 * Validates a media permission check from `session.setPermissionCheckHandler`.
 * Account for Electron signature: `details.mediaType?: string` (single string: 'audio' | 'video').
 * Strictly requires audio-only, main frame, and requestingOrigin matching expected app origin.
 */
export function validatePermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckDetails | undefined,
  expectedOrigin: string,
): boolean {
  if (permission !== 'media') {
    return false;
  }
  if (!details || details.isMainFrame === false) {
    return false;
  }
  if (details.mediaType !== 'audio') {
    return false;
  }
  const isMatchingOrigin =
    requestingOrigin === expectedOrigin ||
    (expectedOrigin === 'null' && (requestingOrigin === 'file://' || requestingOrigin === 'null'));
  if (!requestingOrigin || !isMatchingOrigin) {
    return false;
  }
  return true;
}

/**
 * Registers media permission handlers on an Electron session.
 */
export function registerMediaPermissions(
  sess: Session,
  getExpectedOrigin: () => string,
): void {
  sess.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const granted = validatePermissionRequest(permission, details, getExpectedOrigin());
    callback(granted);
  });

  sess.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    return validatePermissionCheck(permission, requestingOrigin, details, getExpectedOrigin());
  });
}
