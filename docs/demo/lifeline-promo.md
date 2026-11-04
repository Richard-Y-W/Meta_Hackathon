# LIFELINE promo video

**File:** [`lifeline-promo.mp4`](./lifeline-promo.mp4) · 2:40 · 1280×720

Produced for the hackathon submission. Cinematic B-roll and voiceover (Runway: Gen-4
image/video, Eleven v3 narration, Eleven Music, Seed Audio sound effects) bookend a
**continuous, real-time screen capture** of an actual run of the "Cyber intrusion on
the ridge feeder" scenario on `/lifeline/ops` — not staged, not a stitched slideshow.
The capture is OS-level screen recording (ffmpeg `gdigrab`), synced live against the
running simulation via the API, so what's on screen is exactly what the app produced
at that moment, including the clock ticking in real time.

## Timeline

| Time | Beat | Source |
|---|---|---|
| 0:00–0:14 | Cold open: the grid at night | Runway (image → video) |
| 0:14–0:22 | The attack: switch-slip, cut to black, heartbeat | Runway image + Seed Audio SFX |
| 0:22–0:33 | "LIFELINE kept that hospital running." | Brand card |
| 0:33–1:02 | Architecture: Signal → Threat → Physics Check → Armed Town | Title cards, VO on the real Muse/physics-check design |
| 1:02–1:27 | **Live, watching** — the simulator's own clock ticking from T+3 to T+9 as the Incident Intelligence panel receives the real T+8 security alert | Real-time capture, unedited |
| 1:27–1:47 | **The decision** — the fault (red) on the network map and the pre-armed tie (blue) that LIFELINE closed at T+8, well before the attacker opens the recloser at T+45 | Real-time capture, one continuous recording |
| 1:47–2:09 | **The result** — hospital power/water X-ray cutaway, then the water view: everything still at 100%, protected by LIFELINE | Real-time capture, one continuous recording |
| 2:09–2:26 | The real comparison table: conventional control lost 117 MJ, LIFELINE lost none | Real screenshot, Ken Burns |
| 2:26–2:35 | "The same approach scales to every feeder LIFELINE watches." | Real screenshot, Ken Burns |
| 2:35–2:40 | Close | Runway (dawn over the grid) |

The three live-demo beats (1:02–2:09) are three separate unedited recordings of the
same scenario, each used for the moment of the run it best captures — not one
recording cut into pieces. Nothing in them is staged or reordered within a clip.

## Accuracy

Every factual claim is sourced or pulled from the app's own recorded output — no invented
statistics, consistent with [`docs/pitch/lifeline-pitch.md`](../pitch/lifeline-pitch.md)'s
own "what may and may not be said" policy:

- Iran-linked hacking of US water utility control systems: CISA AA23-335A (Dec 2023);
  NSA/CISA/FBI/DC3 advisory (June 2025).
- "Conventional control lost 117 MJ of essential power, LIFELINE lost none" — the actual
  measured result from `docs/results/lifeline-v2-run-0.json`, matching the recorded
  comparison table shown on screen in the video itself.
- "T+8" and "T+45": the real signal/threat/pre-close timestamp and the real line-trip
  timestamp from the captured run's own event log, read directly off the on-screen
  Incident Intelligence panel.

**A caption in an earlier cut was wrong and has been corrected.** It originally read
"3 minutes before the attacker strikes" — copied from an illustrative example in the
pitch doc rather than checked against the footage. The real captured run shows LIFELINE
pre-closing the tie at T+8, more than half an hour before the attacker opens the recloser
at T+45. The caption now says exactly that ("well before the attack lands at T+45")
instead of a fabricated "3 minutes."

## Production notes

**Pacing:** narration is sped up ~12% (pitch-preserved), every visual segment timed
to match, and a low instrumental music bed (Eleven Music, extended via a crossfaded
loop and ducked under the voiceover) runs the whole way through.

**The live-demo section was redone from scratch.** The first cut stitched together
Ken-Burns pans over static screenshots for this section. The screen was re-captured
live against the running simulator, and three separate unedited real-time recordings
were selected and placed where each one matches what the narration says at that
moment — the "watching it happen" recording plays under the line about the T+8 alert,
the map recording (which genuinely shows the fault and the closed tie) plays under the
line about the pre-close decision, and so on.

**A real audio bug, found and fixed:** an earlier cut had audible stutters and
chopped-sounding audio at several points. The cause was `ffmpeg -f concat` (the
*demuxer* variant) used to splice together separately-encoded AAC segments — it
naturally produces clicks/glitches at splice points because each segment's AAC stream
has its own encoder priming/padding that the demuxer doesn't reconcile. The fix was to
assemble the whole timeline in one pass with the concat *filter* instead
(`[0:v][0:a]...[n:v][n:a]concat=n=N:v=1:a=1`), which decodes every segment and
re-encodes once, rather than splicing compressed bitstreams. Verified by rendering
waveforms at every splice point in this final cut — no discontinuities, and a final
loudness pass keeps true peak at a safe -1.5 dBTP (no clipping).

The live captures aren't edited for content — nothing shown was staged or re-ordered —
but each is trimmed to its clearest window. Two lower-third captions fade in/out over
the real footage to call out moments that are easy to miss at a glance (that this is a
live run, and the exact minute the tie closed).
