# 8. Installing, updating and diagnosing

**What it is for.** How the app reaches a machine, how it is updated, and what there is to look at when
something goes wrong.

**Who uses it.** IT and whoever supports the users.

## What you can do

| Capability | What happens |
| --- | --- |
| **Install on macOS** | A zip per architecture, dragged to Applications. Signed with a certificate created once per build machine. |
| **Install on Windows** | A one-click, per-user installer, plus a portable zip. Unsigned. |
| **Run one copy** | Launching a second time is meant to focus the window already open rather than starting another. |
| **See which build is running** | The version is in the sidebar footer, in the About pane, and — on macOS — in the standard About panel. |
| **Cut a release** | One command checks the branch is clean and current, runs the type check and the tests, bumps the version, commits, tags and pushes — behind a single confirmation. The tag then builds both platforms and publishes them. |
| **Retry a failed release** | A second command re-creates the tag for the same version rather than burning the next one. |
| **Open logs folder** | A button in Settings opens the application's diagnostic logs directory in the system file manager (Finder on macOS, Explorer on Windows). |

## How it behaves

- **Neither platform's signature satisfies the operating system.** macOS is self-signed, not notarized;
  Windows is unsigned. First launch therefore needs a deliberate override on both — right-click → Open
  on macOS, *More info → Run anyway* past SmartScreen on Windows. Everything after the first launch is
  normal, and every published release carries the same two sentences explaining it.
- **macOS signing is nonetheless load-bearing.** A stable signature is what keeps the operating
  system's keystore willing to hand back the cached sign-in token across updates; an unsigned build
  would look like a different app every time and re-prompt.
- **The model's engine is fetched per target, not bundled from the build machine.** Each platform's
  binary is downloaded for that target and checked against a published checksum during the build,
  because the one on the build machine only ever matches the build machine. After the macOS build the
  pipeline verifies the signing identity, the bundle identifier, a deep signature check, and that
  exactly one copy of that engine is present.
- **The build refuses a tag that disagrees with the version** in the project file — checked on a cheap
  machine before any expensive build starts — because the artifacts are named from the file, not the
  tag.
- **The local macOS build refuses to start without the signing certificate** and prints the steps to
  create one, unless the certificate is supplied through the environment, which is how the pipeline
  does it.
- **Every push and pull request runs the type check and the test suite.**
- **The window itself is hardened.** The page it runs is locked to its own files with no outside
  connections, no frames and no plug-ins, and the interface has no direct access to the system: the
  whole surface between the two is twenty-odd named calls.
- **Application logs are written to a persistent file.** Standard output, agent lifecycle events, MCP operations, sync progress and errors are written to `logs/app.log` in the application's user data directory with ISO timestamps and scope tags. Secret credentials such as Bearer tokens and Anthropic API keys are scrubbed automatically before being persisted. When `app.log` crosses 5 MB, it rotates to `app.log.1`, keeping at most one archive file to bound disk space to 10 MB total. Quitting waits for the log to reach disk, so the lines written during shutdown are in the file rather than lost with the process — bounded, so a stuck disk delays closing the app briefly instead of preventing it.

## Limits

- **There is no automatic update.** Updating means sending a new file and having each user install it.
  Nothing tells a user their copy is old, and nothing tells the team which versions are in the field.
  The build even produces update-feed files; nothing publishes them.
- **The release build does not run the tests.** The type check and the tests run on every push, and the
  local release command runs them again — but the workflow the tag triggers depends on neither, so a
  red test does not stop a release cut from a tag pushed by hand.
- **The app icon is not in the repository.** It sits in the working tree of whoever made it and nothing
  ignores it — it was simply never committed — so a fresh clone builds without the artwork the build
  file names.
- **Log retention is capped at one archive file (10 MB total).** Once the active log file crosses 5 MB, it rotates to `app.log.1` and replaces any previous archive; diagnostic history beyond 10 MB is discarded rather than maintained indefinitely.
- **There is no crash reporting, no telemetry and no diagnostics bundle.** A user's report is the only
  signal that anything went wrong.
- **The app installs no menu of its own, so the platform's stock one ships** — its View menu supplies
  Reload, Force Reload, Toggle Developer Tools and zoom, on their usual shortcuts, in a released build.
  Reloading mid-answer strands the running turn: the interface forgets which conversation was open, so
  the turn continues, finishes and is saved with nothing on screen following it.
- **Two of the app's own protections are effectively inert once packaged.** The check that pins the
  window to its own content, and the check that only the app's own window may call into it, both
  compare an origin that a file-loaded page reports as the literal word "null" — which every other
  file-loaded page reports too. Both are meaningful in development and largely decorative in a shipped
  build; the window's other hardening is what actually carries it.
- **Only secure web links and email addresses are handed to the operating system.** Everything else —
  including a plain insecure web link — is dropped with no error and no feedback.
- **On macOS the app survives its last window closing, and the reference to that window is never
  cleared** — so a second launch after closing the window can try to focus one that no longer exists
  rather than opening a new one.
- **The app's own title strip is 40 pixels tall on every platform.** On macOS and Windows it replaces
  the system title bar; anywhere else the system bar stays and the strip sits under it, costing 40
  pixels for nothing.
- **A handful of colours and the title-strip height are written out twice** — once for the window frame
  and once for the interface — with a comment asking that they be kept in step and nothing checking
  that they are.
- **Only three targets are built** — macOS on both architectures and Windows on x64. There is no Linux
  build and no ARM Windows build.
- **A published release cannot be replaced by re-tagging alone.** Deleting the tag leaves the release
  behind; it has to be removed by hand first.
- **Nothing in the test suite covers the app's lifecycle, the boundary between its two halves, the
  settings store, the packaging configuration or the release scripts.** Twenty-three test files cover
  the agent loop, the stores and the interface components; everything in this chapter is untested.

## Not supported

- Auto-update, update notifications, or any check for a newer version.
- Notarization or a trusted publisher signature on either platform.
- Central deployment, managed installation, or any way to push a configuration with the app.
- An in-app log viewer, a support bundle packager, or automated telemetry upload to send diagnostics to a server.
- Rolling back to a previous version from inside the app.
- Removing the user's data on uninstall. The Windows uninstaller leaves the cached conversations, the
  search index and the encrypted token cache in place.

