# LIFELINE promo video

**File:** [`lifeline-promo.mp4`](./lifeline-promo.mp4) · 2:09 · 1280×720

Produced for the hackathon submission. Cinematic B-roll and voiceover (Runway: Gen-4
image/video, Eleven v3 narration, Seed Audio sound effects) bookend a **continuous,
real-time screen capture** of an actual run of the "Cyber intrusion on the ridge
feeder" scenario on `/lifeline/ops` — not staged, not a stitched slideshow. The
capture is OS-level screen recording (ffmpeg `gdigrab`), synced live against the
running simulation via the API, so what's on screen is exactly what the app produced
at that moment, including the clock ticking in real time.

## Timeline

| Time | Beat | Source |
|---|---|---|
| 0:00–0:16 | Cold open: the grid at night | Runway (image → video) |
| 0:16–0:25 | The attack: switch-slip, cut to black, heartbeat | Runway image + Seed Audio SFX |
| 0:25–0:37 | "LIFELINE kept that hospital running." | Brand card |
| 0:37–1:09 | Architecture: Signal → Threat → Physics Check → Armed Town | Title cards, VO on the real Muse/physics-check design |
| 1:09–2:04 | **Live demo, continuous** | Real-time capture: the dashboard ticking through the attack, the fault (red) and the pre-armed tie (blue) on the network map, the hospital's power/water X-ray cutaway, the real comparison table, the water view — all one unbroken recording with two small animated caption call-outs |
| 2:04–2:10 | Close | Runway (dawn over the grid) |

## Accuracy

Every factual claim is sourced or pulled from the app's own recorded output — no invented
statistics, consistent with [`docs/pitch/lifeline-pitch.md`](../pitch/lifeline-pitch.md)'s
own "what may and may not be said" policy:

- Iran-linked hacking of US water utility control systems: CISA AA23-335A (Dec 2023);
  NSA/CISA/FBI/DC3 advisory (June 2025).
- "Conventional control lost 117 MJ of essential power, LIFELINE lost none" — the actual
  measured result from the captured run, matching the recorded comparison table shown
  on screen in the video itself.

## Production notes

The capture isn't edited for content — nothing shown was staged or re-ordered — but it
is trimmed: two early segments where another window briefly covered the recording
region were cut, and the final frame is held a few extra seconds to match the
narration length. Two lower-third captions fade in/out over the real footage to call
out moments that are easy to miss at a glance (that this is a live run, and the exact
minute the tie closed).
