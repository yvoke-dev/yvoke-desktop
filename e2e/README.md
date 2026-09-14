# End-to-End (E2E) Testing with Playwright

This directory contains end-to-end (E2E) tests for the Yvoke desktop application, implemented using [Playwright](https://playwright.dev/)'s Electron integration (`@playwright/test` and `_electron`).

---

## Running Tests

Before running tests, the Electron main, preload, and renderer packages must be built. All test scripts automatically run `npm run build` prior to test execution.

### Headless CLI Mode (Default)
Runs the test suite headlessly in the terminal:
```bash
npm run e2e
```
In headless mode, Electron initializes with `show: false`, `backgroundThrottling: false`, and `--disable-gpu` to prevent window focus stealing or blank rendering.

### Interactive UI Mode
Opens Playwright's interactive visual test dashboard:
```bash
npm run e2e:ui
```
UI Mode allows you to:
- Select and run individual specs or test cases.
- Step through test actions with time-travel DOM snapshots.
- View console logs, network activity, and locators.
- Watch the Electron window interactively alongside the test runner.

### Headed Terminal Mode
Runs tests directly in the terminal while displaying the native Electron application window:
```bash
npm run e2e:headed
```

### Type Checking
Typechecks the E2E test suite and Playwright configuration without polluting the main Node or Web compiler targets:
```bash
npm run typecheck:e2e
```

---

## Architectural Principles & Test Fixture

Tests utilize the custom fixture defined in [`e2e/support/electronFixture.ts`](support/electronFixture.ts):

1. **Storage & Profile Isolation**:
   - Each test invocation creates a fresh, isolated temporary directory in `os.tmpdir()` (`yvoke-e2e-*`).
   - `process.env.YVOKE_USER_DATA_DIR` overrides Electron's `userData` path.
   - The user's production profile (`~/Library/Application Support/Yvoke - Desktop/`) is never modified or read.
   - Prevents `app.requestSingleInstanceLock()` collisions with active desktop instances.

2. **Built-in Mock/Dev Authentication**:
   - The fixture pre-seeds `userData/settings.json` with `serverAuthMode: "dev"`.
   - The app signs in automatically as `dev-mode (mock security)` using `DEV_TOKEN = 'dev-local-token'`.
   - No external Azure Entra login or Claude CLI login is required.

3. **Loopback Containment**:
   - `serverBaseUrl` is seeded to `http://127.0.0.1:0`.
   - Prevents any outbound WAN traffic to remote staging or production servers (`https://app.yvoke.dev/`).

4. **Resilient Process Teardown**:
   - Gracefully closes `electronApp` upon test completion.
   - Falls back to `SIGKILL` on the child process if ungraceful termination or hang occurs within 5 seconds.
   - Recursively deletes the temporary `userData` directory.

5. **Build Preflight Check**:
   - Verifies that `out/main/index.js` exists before attempting launch. If missing, throws an immediate actionable error directing the developer to run `npm run build`.

---

## Environment Variables

The test harness and Electron main process recognize the following environment variables:

| Variable | Description |
| :--- | :--- |
| `YVOKE_HEADLESS` | Controls window visibility. Set to `'1'` to run headlessly (`show: false`, `backgroundThrottling: false`, `--disable-gpu`). Set to `'0'` (or pass `--headed`) to force window display. |
| `YVOKE_USER_DATA_DIR` | Sets a custom path for Electron's `userData` directory before acquiring the single-instance lock. Automatically managed by the test fixture. |
