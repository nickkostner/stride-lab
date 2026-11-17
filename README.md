# Stride Lab

Running-form analysis from video, in the browser. The pose model runs on your device; video never leaves it.

- **Live (TV):** `https://nickkostner.github.io/stride-lab/`. Real-time analysis on a treadmill: iPad camera, or a Wyze cam through the bridge.
- **Upload:** `https://nickkostner.github.io/stride-lab/upload/`. Analyse a recorded 5–10 s side-on clip, with a teardown of how Ochy works.

Both are published by `.github/workflows/pages.yml` on every push to `main`.


## Live mode

Live running-form analysis on a treadmill. A camera films you from the side (an iPad, which also runs the analysis, or a Wyze cam feeding a small computer), and a TV in front of the treadmill shows your cadence, shin angle at landing, bounce, ground contact, trunk lean and knee bend. Each number updates every second, with a coaching cue.

```
Wyze cam (side-on) --Wi-Fi--> mini PC / laptop --HDMI--> TV
                              ├─ camera bridge (Docker): Wyze -> WebRTC
                              ├─ nginx :8080 (web app + /cam proxy)
                              └─ Chrome fullscreen: pose model + analysis
```

## iPad route (recommended): no computer, no Docker

The iPad (an M1 iPad Pro or similar) films you, runs the analysis, and mirrors its screen to the TV.

```
iPad Pro (side-on, on a stand) --USB-C to HDMI cable, or AirPlay--> TV
```

1. **Host the app.** It is already hosted at `https://nickkostner.github.io/stride-lab/` (Settings → Pages → Source must be "GitHub Actions"). Safari only allows camera access on an https address, which is why it has to be hosted.
2. **Install it on the iPad.** Open that address in Safari, tap Share → Add to Home Screen, then open it from the home screen so it runs fullscreen. Allow the camera when asked.
3. **Choose the right lens.** In Settings (top right), set Camera to "This device's camera" and Which camera to **Back Camera**. Do not use "Back Ultra Wide Camera", which bends the image.
4. **Connect the TV.** A USB-C to HDMI adapter mirrors with no delay. AirPlay works too but adds about 1–2 seconds.
5. **Set up the iPad.** Mount it side-on at hip height, 3–4 m away, in landscape. Set Settings → Display & Brightness → Auto-Lock to Never and keep it charging. Guided Access (Settings → Accessibility) stops a stray tap from leaving the app.

The top bar shows what the iPad achieves: the camera's resolution and frame rate, then "N of 60 fps · pose X ms GPU/CPU", where N is how many frames per second are actually analysed. I have not measured these on a real iPad. On first start the app tries both the graphics chip and the processor for a few seconds and keeps the faster.

## Computer + Wyze route

### What you need

- **A Wyze cam.** v2, v3, Pan or v4 all work through the bridge.
- **A computer for the TV.** Any recent laptop or mini PC with an HDMI port, running Linux, with Docker and Chrome or Chromium. An Intel N100 mini PC is plenty. A Raspberry Pi 5 is untested; use the Lite model if you try one.
- **No phone or smart-TV browser.** They are too slow for the pose model.

## Accuracy at Wyze frame rates

The Wyze sends 15–20 fps (v3 default: 20 fps by day, 15 at night). The table shows the worst error over 8 simulated runs at each frame rate, against a 240 fps reference:

| fps | cadence | shin at landing | knee at landing | ground contact |
|-----|---------|-----------------|-----------------|----------------|
| 15  | ±0.9 spm | ±4.5° | ±3.3° | ±28 ms |
| 20  | ±0.4 spm | ±1.7° | ±1.8° | ±13 ms |
| 30  | ±0.2 spm | ±0.7° | ±0.7° | ±7 ms  |

These are best-case numbers from clean simulated joints. Real error will be larger, mostly from motion blur on the feet. Keep the camera in day mode (night vision off) and light the room well. On a v3 with wz_mini_hacks you can raise the frame rate to 30.

## Setup

1. **Place the camera.**
   - Side-on to the treadmill, 2.5–3.5 m away, lens at hip height.
   - Your whole body, feet included, in frame through the whole stride.
   - You near the centre of the image: the wide-angle lens bends lines near the edges.
2. **Install Docker.** On the TV computer: `curl -fsSL https://get.docker.com | sh`
3. **Download the pose model and runtime.** Run `./fetch-assets.sh` once. It saves about 25 MB into `web/vendor`.
4. **Configure.** `cp .env.example .env`, then fill in `HOST_IP` (this computer's LAN IP) and either:
   - **Wyze account route (any model).**
     - Get an API ID and key at developer-api-console.wyze.com.
     - Set `WYZE_EMAIL`, `WYZE_PASSWORD`, `WYZE_API_ID`, `WYZE_API_KEY`, and `WYZE_CAMERA_NAME` (the camera's nickname in the Wyze app).
     - Start with `docker compose --profile wyze up -d`.
   - **RTSP route (v2/v3/Pan on Wyze's RTSP firmware, or wz_mini_hacks).**
     - Put the camera's RTSP URL in `mediamtx.yml`.
     - Start with `docker compose --profile rtsp up -d`.
     - This route needs no cloud login and is lighter.
5. **Open the app.** Go to http://localhost:8080, press **S** for Settings, and set the stream address:
   - **Wyze route:** `/cam/<camera-name>/whep`. The name is lower case with dashes, so "Treadmill Cam" becomes `/cam/treadmill-cam/whep`.
   - **RTSP route:** `/cam/treadmill/whep`.
6. **Make it start on the TV by itself.**
   ```
   chromium --kiosk --autoplay-policy=no-user-gesture-required "http://localhost:8080/?autostart=1"
   ```

## Using it

- **Keys:** **Space** starts and stops, **S** opens settings, **M** toggles the metronome, **F** goes fullscreen.
- **Numbers on screen:** they appear after about 6 s of steady running and cover the last 8 s. Change the window in Settings: 6 s reacts faster, 12 s is steadier.
- **Coaching cues:** shown only when a metric is out of range in 3 of the last 5 updates, and each cue stays up for at least 8 s.
- **Voice cues** (tick the box in Settings) speak the cue through the TV.
- **Session summary:** stopping a session shows averages and time in range for every metric.
- **The fps chip:**
  - It reads "19 of 20 fps · pose 32 ms": the second number is what the camera sends, the first is what gets analysed.
  - If the first drops below 10, switch to the Lite model, or try the graphics card in Settings.

## What was tested

These parts were tested:

- **Pipeline:** a simulated 20 fps H.264 RTSP camera fed MediaMTX, through this exact compose file and nginx config, into Chrome over WebRTC (WHEP). It connected, and frames reached the pose model at 19 of 20 fps (32 ms per frame, full model on the processor).
- **Analysis:** checked end to end on a simulated runner, including uneven frame timing and 10% dropped frames.

- **iPad camera path:** tested in Chromium with a simulated 60 fps camera at iPad Pro 11" screen size. It opened the camera at 1280×720 @ 60, the automatic speed check compared both options and kept the faster in about 10 s, and it analysed 28–30 of 60 fps on this test machine.

Not tested:

- Safari, or an actual iPad: real speed on the M1, and whether Safari offers 60 fps to web pages.

- A real Wyze camera or the Wyze bridge container (no account or camera was available).
- A real person on a treadmill.
- Accuracy against a lab.

## Files

- `web/upload/index.html`: upload analyser and Ochy teardown
- `web/index.html`: TV app (sources, live loop, tiles, cues, metronome, summary)
- `web/gait.js`: analysis core, shared with the upload version. Runs in Node for tests.
- `docker-compose.yml`, `nginx.conf`, `mediamtx.yml`, `.env.example`: camera bridge and web server
- `fetch-assets.sh`: downloads the MediaPipe Tasks Vision 0.10.14 runtime and the Pose Landmarker models
