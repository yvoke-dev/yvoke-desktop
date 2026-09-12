import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  validatePermissionRequest,
  validatePermissionCheck,
  registerMediaPermissions,
} from '../src/main/mediaPermissions';

const APP_ORIGIN = 'http://localhost:5173';

describe('Media Permissions - validatePermissionRequest', () => {
  it('grants permission when origin matches appOrigin, isMainFrame is true, and mediaTypes is ["audio"]', () => {
    const granted = validatePermissionRequest(
      'media',
      {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: `${APP_ORIGIN}/index.html`,
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(true);
  });

  it('rejects permission request when isMainFrame is false', () => {
    const granted = validatePermissionRequest(
      'media',
      {
        isMainFrame: false,
        mediaTypes: ['audio'],
        requestingUrl: `${APP_ORIGIN}/index.html`,
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects non-media permission types', () => {
    const granted = validatePermissionRequest(
      'geolocation',
      {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: `${APP_ORIGIN}/index.html`,
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects empty mediaTypes array or missing mediaTypes', () => {
    expect(
      validatePermissionRequest(
        'media',
        {
          isMainFrame: true,
          mediaTypes: [],
          requestingUrl: `${APP_ORIGIN}/index.html`,
        },
        APP_ORIGIN,
      ),
    ).toBe(false);

    expect(
      validatePermissionRequest(
        'media',
        {
          isMainFrame: true,
          requestingUrl: `${APP_ORIGIN}/index.html`,
        },
        APP_ORIGIN,
      ),
    ).toBe(false);
  });

  it('rejects video requests (details.mediaTypes = ["video"] or ["audio", "video"])', () => {
    expect(
      validatePermissionRequest(
        'media',
        {
          isMainFrame: true,
          mediaTypes: ['video'],
          requestingUrl: `${APP_ORIGIN}/index.html`,
        },
        APP_ORIGIN,
      ),
    ).toBe(false);

    expect(
      validatePermissionRequest(
        'media',
        {
          isMainFrame: true,
          mediaTypes: ['audio', 'video'],
          requestingUrl: `${APP_ORIGIN}/index.html`,
        },
        APP_ORIGIN,
      ),
    ).toBe(false);
  });

  it('rejects untrusted schemes: blob:, javascript:, data:, about:blank', () => {
    const untrustedUrls = [
      'blob:http://localhost:5173/uuid',
      'javascript:void(0)',
      'data:text/html,<html></html>',
      'about:blank',
    ];

    for (const url of untrustedUrls) {
      const granted = validatePermissionRequest(
        'media',
        {
          isMainFrame: true,
          mediaTypes: ['audio'],
          requestingUrl: url,
        },
        APP_ORIGIN,
      );
      expect(granted).toBe(false);
    }
  });

  it('rejects malformed requesting URLs', () => {
    const granted = validatePermissionRequest(
      'media',
      {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: 'not a valid url',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects foreign origins (e.g. https://evil.com)', () => {
    const granted = validatePermissionRequest(
      'media',
      {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: 'https://evil.com/app',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });
});

describe('Media Permissions - validatePermissionCheck', () => {
  it('grants check when origin matches appOrigin, isMainFrame is true, and mediaType is "audio"', () => {
    const granted = validatePermissionCheck(
      'media',
      APP_ORIGIN,
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(true);
  });

  it('rejects permission check when isMainFrame is false', () => {
    const granted = validatePermissionCheck(
      'media',
      APP_ORIGIN,
      {
        isMainFrame: false,
        mediaType: 'audio',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects permission check for video requests (details.mediaType = "video")', () => {
    const granted = validatePermissionCheck(
      'media',
      APP_ORIGIN,
      {
        isMainFrame: true,
        mediaType: 'video',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects permission check for non-media permission types', () => {
    const granted = validatePermissionCheck(
      'geolocation',
      APP_ORIGIN,
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects permission check for foreign origin', () => {
    const granted = validatePermissionCheck(
      'media',
      'https://evil.com',
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('grants check when requestingOrigin is "file://" and expectedOrigin is "null" (production packaged app)', () => {
    const granted = validatePermissionCheck(
      'media',
      'file://',
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      'null',
    );
    expect(granted).toBe(true);
  });

  it('rejects check when requestingOrigin is "file://" but expectedOrigin is dev server origin', () => {
    const granted = validatePermissionCheck(
      'media',
      'file://',
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      APP_ORIGIN,
    );
    expect(granted).toBe(false);
  });

  it('rejects check when requestingOrigin is foreign origin and expectedOrigin is "null"', () => {
    const granted = validatePermissionCheck(
      'media',
      'https://evil.com',
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
      'null',
    );
    expect(granted).toBe(false);
  });
});

describe('Media Permissions - registerMediaPermissions', () => {
  it('registers both request and check handlers on session', () => {
    let requestHandler: any;
    let checkHandler: any;
    const mockSession = {
      setPermissionRequestHandler: vi.fn((fn) => {
        requestHandler = fn;
      }),
      setPermissionCheckHandler: vi.fn((fn) => {
        checkHandler = fn;
      }),
    };

    registerMediaPermissions(mockSession as any, () => APP_ORIGIN);
    expect(mockSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(mockSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    const callback = vi.fn();
    requestHandler(
      null,
      'media',
      callback,
      {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: `${APP_ORIGIN}/index.html`,
      },
    );
    expect(callback).toHaveBeenCalledWith(true);

    const checkResult = checkHandler(
      null,
      'media',
      APP_ORIGIN,
      {
        isMainFrame: true,
        mediaType: 'audio',
      },
    );
    expect(checkResult).toBe(true);
  });
});

describe('Packaging Configuration - electron-builder.yml', () => {
  it('defines non-empty mac.extendInfo.NSMicrophoneUsageDescription', () => {
    const builderConfigPath = path.resolve(__dirname, '../electron-builder.yml');
    const content = fs.readFileSync(builderConfigPath, 'utf8');
    const macSection = content.split(/^mac:/m)[1]?.split(/^[a-z0-9_-]+:/m)[0] ?? '';
    const match = macSection.match(/NSMicrophoneUsageDescription:\s*['"]?(.+?)['"]?\s*$/m);
    expect(match).toBeDefined();
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });
});
