# Regression tests

Node.js 22 or newer is required. No npm packages are needed.

```sh
node tests/run-all.mjs
node tests/run-all.mjs --browser
```

The first command runs source/PWA validation, unit suites, and JavaScript syntax checks. `tests/check-syntax.mjs` discovers root application scripts, scripts under `assets/js/`, and all test scripts. The second command also runs twenty browser suites using an installed Chromium/Google Chrome. Set `CHROME_PATH` if its executable is not in the usual Windows location or on PATH. Results and screenshots are written to ignored `test-results/`.

Browser suites create fresh profiles, deny camera and microphone access, and use temporary loopback servers, synthetic media and isolated storage. They do not attach to an existing browser or phone and do not read a user's gallery. Shared and downloaded files in the media suite are intercepted by test stubs.

Coverage also includes gallery handle resizing, long-press/keyboard selection, batch delete rollback, share cancellation/unsupported states, original-file ZIP downloads, photo-only PDF failure paths, off-page selection, and 200% landscape focus. Synthetic canvas streams cover compatible stream reuse, reconnect frame holds, stale camera requests, first-frame timeouts and persistent torch placement. OS share and download APIs are stubbed; no physical camera is used.

Coverage includes photo navigation, video posters and object-URL cleanup; modal stacking and background scroll restoration; settings resize/flick/cancellation and accessible keyboard controls; mode-indicator motion and microphone labels; physical-device-relative layout, both landscape directions, safe insets and reduced visual viewports. These checks do not establish behavior on a real Galaxy S25 or Adblock Browser, physical camera cutouts, real IME/browser chrome, or actual recording output.

The fixtures are generated color/test patterns, not captured media:

- `portrait.mp4`: 180×320, two seconds, H.264, no audio.
- `landscape.mp4`: 320×180, two seconds, H.264, initially black to exercise non-black representative-frame selection, no audio.
- `stream.webm`: 160×90, VP9 with live/unknown-duration metadata, no audio.

Equivalent fixtures can be generated with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=180x320:rate=12 -t 2 -an -c:v libx264 -pix_fmt yuv420p tests/fixtures/portrait.mp4
ffmpeg -f lavfi -i color=black:size=320x180:rate=12:duration=0.25 -f lavfi -i testsrc2=size=320x180:rate=12:duration=1.75 -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0' -an -c:v libx264 -pix_fmt yuv420p tests/fixtures/landscape.mp4
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=12 -t 2 -an -c:v libvpx-vp9 -f webm -live 1 tests/fixtures/stream.webm
```

Preview fitting is also checked across all photo/video ratios in portrait and both landscape directions. Tests compare announced photo crops with six generated PNG exports, decode six short canvas-stream recordings to verify actual output dimensions, and exercise unsupported/rejected/misreported video ratios. These recordings contain only generated test patterns.

P1–P9 integration adds explicit recording lock/final-BlobEvent/crash recovery coverage; a 768-case delayed-output budget model; chunk-backed completion, exact-Blob hydration, reference-counted transactional deletion and quota rollback; unverified raw-data export; automatic foreground verification retry; 240-item history refresh, asynchronous selection revalidation, modal/backdrop/manual-review/PDF navigation and scaled PC text checks.

The preview-fit suite first waits for >1 KiB of actual output from a separate same-codec encoder preparation run, then retains all output-dimension and crop assertions. The PC suite explicitly checks aria-pressed after fixture state synchronization. Aggregate device-media status is derived from fresh child audits; missing evidence is null, never a claimed false. The full aggregate includes the recording, review/history and continuous-capture browser suites instead of combining independent reruns into a success.

These tests use generated data and new isolated origins/profiles. Legacy Blob records remain readable; newly recorded videos may reference their persisted chunks. Do not run different app versions against the same origin/database. Real-device media permissions, OS share/download outcomes, physical camera output and long recordings still require separate authorized validation.

Legacy recording sessions have no Web Lock protocol marker. Startup and automatic/forced recovery keep them intact, including empty-looking rows. The recovery UI requires explicit confirmation that old-version tabs and recordings are closed before it adopts those sessions. Formal recording tests cover cancellation and confirmed recovery; no elapsed-time heartbeat is accepted as proof that an old tab is dead. Completed legacy photo/video/PDF Blobs remain compatible with this version. A rollback to old application code after new chunk-backed recordings have been created is unsupported; retain a compatible storage reader and recording protocol in any corrective release.

The PC control suite uses the fixed v2026.10.25.3 production-assets fixture in `tests/fixtures/pc-controls-v20261025.3.zip`. It verifies the archive and each file against the companion SHA256 manifest and extracts only into its owned temporary directory; no sibling local checkout is required. The ZIP is a test input, not an old runnable application hosted under the public site. Renderer-crash coverage waits for an observed crash event before independently checking Web Lock release and durable-data recovery. CI preserves synthetic JSON/PNG evidence after a failed browser run.

PC fixtures explicitly declare a fine mouse/hover input and assert that touch emulation changes the actual browser media queries, since a headless Linux runner may have no physical pointer. On Linux, where the runner's Chrome 155 leaves `Page.crash` pending, the crash fixture obtains the owner's renderer PID from a unique browser trace mark, verifies its type/ownership against the same browser's process inventory and a separate observer, and kills only that PID. It must then observe the crash, lock release and durable recovery; missing ownership or crash evidence fails the test. `QC_CRASH_BACKEND=owned-renderer` exercises that injection on other platforms. This never searches process names or targets an existing profile.

Linux CI runs the PC suite with `QC_PC_HEADED=1` inside an ephemeral `xvfb-run` desktop with TCP listening disabled. This provides an actual virtual mouse/hover device across mobile/desktop emulation changes instead of relying on launch-only Blink settings or overriding the application's media-query results. Desktop and crash preflights fail early; the complete 20-suite aggregate still runs afterward. Xvfb is preinstalled on the runner and is closed by its wrapper; the user's desktop and trial server are unrelated.

Continuous capture regression uses real canvas-stream photos/recordings in isolated profiles. It verifies fresh/legacy automatic-review preferences never open a result modal, consecutive capture, delayed storage/finalization gates, quota errors, retained video recovery and explicit history playback. The removed automatic-review setting is ignored; existing media/settings keys and database schema are unchanged.

Mixed photo/video detail navigation follows history order, including timestamp ties and page boundaries. Generated PDF documents remain excluded as before. The generated VP8/Opus tone fixture contains no camera or microphone data. Browser tests cover playback stop/unload, no autoplay, native-control regions, zoom, keyboard/buttons, boundaries, pending close/reselection, deletion and URL cleanup. Native mobile controls still require real-device checks.

Generate the audio fixture with FFmpeg (no capture device):

```sh
ffmpeg -f lavfi -i testsrc2=size=360x240:rate=12 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:v libvpx -b:v 250k -pix_fmt yuv420p -c:a libopus -b:a 32k -shortest tests/fixtures/synthetic-tone.webm
```

`synthetic-tone.json` records ffprobe-confirmed streams and the SHA256; regenerate its hash/stream metadata if the fixture is regenerated. The mixed suite validates the hash and drags the actual Chromium native timeline through CDP, asserting that playback position changes without history navigation.

The structure-upgrade suite exports the fixed pre-refactor commit `d1d3387cc2a9d09584f44dcabcdd8e56f61ae231` through read-only Git object access into its own temporary directory. That commit must be available locally; CI fetches repository history for this suite. It serves the old and new application consecutively at its own `/quiet-camera/` origin with a real Service Worker, verifies consent and recording-finalization gates before updating, and then reloads with network requests unavailable. It compares the database name/version, object stores/indexes, every seeded media/chunk/session field and Blob hash, settings keys, selected camera, and hydrated legacy/chunk-backed media across the update. All seeded media is generated; a pending legacy session must remain intact. Storage code and all four moved CSS files must also match the fixed commit byte for byte. DOM-click checks cover single dispatch for camera controls, a synthetic photo, save/share, and cancelled deletion. These checks do not establish physical-device behavior or OS share/download outcomes.
