# Playing with the phone locked (website)

What the listen-through does on the plain mobile website (iOS Safari, Android Chrome) when the screen goes off, and where browsers stop it. The iOS app plays on natively (`docs/mobile.md`); none of this applies there.

## How it keeps going

- **One source.** Browsers let a hidden page keep playing a media element that is already playing; what they don't reliably allow is a hidden page starting a new source (iOS Safari especially). Line by line, the player gives its `<audio>` element a new source for every line and gap (`player/engine.ts`), so the stretch ahead plays from one file, a listen track (`player/listenTrack.ts`, `backend/src/track/`). The server builds the usual ones ahead of time (the full read and each cast member's "Pause, then read", `track/prebuild.ts`), and the player asks for its stretch as soon as it opens, so the first play usually starts on the track; when it isn't ready yet, play starts line by line and the engine moves onto the track once it arrives. From then on next, previous, a tapped line and the scene picker are seeks in that one file.
- **One switch at a time.** Moving onto a track costs one new source: when a line ends line by line, the engine enters the track in the pause before the next line (when the track holds that pause, which it does for any track asked for from an earlier line); at the end of a 300-line track it enters the next one the same way. A play after a pause (a tap, or the lock screen's play button) carries on from the same moment in the track when one covers it, so resuming a stopped phone lands on the one file.
- **No timers.** Everything that advances the play is an `ended` or `timeupdate` event from the element: clips, the pauses between lines and the listener's speaking pause are audio (silent WAVs line by line, real silence inside a track). Animation frames only move the highlighting while the page shows. On a track, the speed for each line (other people's at the chosen speed, pauses and the listener's own at 1×) also changes at each item boundary from one timeout set for that boundary, since a locked phone has no frames and only about 4 `timeupdate`s a second (at 4× the listener's pause would otherwise start up to a second early); playback never waits on it. `engine.test.ts` plays a whole scene change, a speaking pause and the listener's line with no timer set.
- **Lock screen and headphones.** `native/nowPlaying.ts` uses the Media Session API: the line (speaker and text), the production and the scene; play, pause, stop, next line and previous line. No seek handlers, so iOS shows next and previous rather than skip-15-seconds. Leaving the player clears it.
- **The screen.** `audio/wakeLock.ts` keeps the screen on while the play runs and the page shows; locking the phone is still the listener's choice, and nothing needs the screen on to keep playing. The wake-lock fallback video (iOS before 16.4, Low Power Mode) is paused while the page is hidden, so the run-through is the only media playing in a locked phone.

## "Pause, then read" with the screen off

It does what it does on screen: the cue plays, then a silence as long as the line takes to say (the countdown is only on screen), then the line is read so the listener can check themselves. That silence is the prompt; nothing is added for screen-off listening. "Skip" leaves the silence alone, "Read" plays the line.

## "Skip to my cues" with the screen off

The skips are in the track, which is the listener's own, so it isn't built ahead: it is asked for from their line when the player opens and built then. The server leaves out the lines a skip passes over and plays the fast-forward sound in place of the pause (`skips` in the track request), so a locked phone skips without a new source. A stop before a very long stretch ends the track there; the player pauses (the lock screen shows it paused, its title saying where the next line is) and asks for the stretch after the jump as the listener nears the stop, so pressing play on the lock screen lands on a track that is already built. If it isn't ready yet, the jump starts line by line, which a locked iPhone may refuse until the screen is on.

## What the listener sees

Under the player's controls, while it plays:

- "Getting ready to play with the screen locked… Keep the screen on until then." while the track builds (one that wasn't built ahead: another part or mode, or straight after a change; a cold production, mostly synthesized voices not yet made, can take minutes).
- "Ready to play with the screen locked." once on the track.
- "This part can't play with the screen locked yet. Keep the screen on." when the track failed (three tries, ten minutes apart) or wouldn't play (an expired link, a network error): that stretch plays line by line.
- Back on the page after a locked phone stopped it: "The phone stopped the play while the screen was off. Press play to carry on." (`interrupted` in the engine: a play refused or a pause the system made while hidden; a pause the listener asks for, the lock screen's included, never counts).

## Limits

- **Locked before the track is ready.** Line by line, the play may stop at the end of the clip that was playing (iOS Safari). The lock screen shows it paused; its play button carries on, onto the track if it has arrived. The track's 3 s poll is a timer, so a hidden page may slow it down (Chrome throttles a hidden page's timers, and iOS may suspend them), and a track still building when the phone locks may only arrive once the screen is back on.
- **Track to track.** Every 300 lines (or after a jump outside the track) there is one new source; a locked phone that refuses it stops there, as above.
- **Android lock-screen controls.** Chrome shows its media notification only for media longer than about 5 seconds, so line by line (short clips) there may be no controls on the lock screen; they appear once the player is on the track.
- **Another app's audio, a call, or the system.** They pause the play like any media; it doesn't resume by itself. The lock screen's play, or the page's, carries on.
- **Battery savers.** An aggressive Android battery saver can freeze a background tab whatever it plays. Nothing the page can do.

## Verified

Unit tests (Vitest, node): the engine's moves onto tracks, resuming onto a track, `interrupted`, timer-free advancing, the Media Session wiring and the screen note. Not yet verified on a locked iPhone or Android phone; that check belongs to the review of the PR that added it.
