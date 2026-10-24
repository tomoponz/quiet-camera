# Regression tests

Node.js 22 or newer is required. No npm packages are needed.

```sh
node tests/run-all.mjs
node tests/run-all.mjs --browser
```

The first command runs source/PWA validation, unit suites, and JavaScript syntax checks. The second also runs eight browser suites using an installed Chromium/Google Chrome. Set `CHROME_PATH` if its executable is not in the usual Windows location or on PATH. Results and screenshots are written to ignored `test-results/`.

Browser suites create fresh profiles, deny camera and microphone access, and use temporary loopback servers, synthetic media and isolated storage. They do not attach to an existing browser or phone and do not read a user's gallery. Shared and downloaded files in the media suite are intercepted by test stubs.

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
