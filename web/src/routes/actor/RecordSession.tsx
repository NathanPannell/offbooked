import { Headphones, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { ActorApi } from "../../api/actor";
import { errorMessage } from "../../api/client";
import type { ActorLine, Invite, SttResult } from "../../api/types";
import { useAccompaniment, usePlayback, useTakeRecorder } from "../../audio/useTakeRecorder";
import { Brand } from "../../components/Brand";
import { CharacterName } from "../../components/CharacterName";
import { Dialog } from "../../components/Dialog";
import { InAppBanner } from "../../components/InAppBanner";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { RecordDock } from "../../components/RecordDock";
import { SectionNav } from "../../components/SectionNav";
import { useToast } from "../../components/Toast";
import { readStorage, writeStorage } from "../../lib/storage";
import { useResource } from "../../lib/useResource";
import { keepInView, recorderBand } from "../../player/follow";
import { useLiveTake } from "../../stt/useLiveTake";
import { useSttSession } from "../../stt/useStt";
import { latestForLine } from "../../upload/queue";
import { useUploads } from "../../upload/useUploads";
import { LineCard, type LocalTake } from "./LineCard";
import { NameEditor } from "./NameEditor";
import { PickUpParts } from "./PickUpParts";
import { Wrapped } from "./Wrapped";

const ADVANCE_DELAY_MS = 700;
const AUTO_ADVANCE_KEY = "offbooked.autoAdvance";
const KEEP_RECORDING_KEY = "offbooked.keepRecording";
const HEAR_PARTNERS_KEY = "offbooked.hearPartners";

function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    const stored = readStorage(key);
    return stored === null ? fallback : stored === "1";
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStorage(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set] as const;
}

export interface Score {
  takeKey: string;
  result: SttResult;
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function RecordSession({
  token,
  api,
  invite,
  onRenamed,
  onPartsChanged,
}: {
  token: string;
  api: ActorApi;
  invite: Invite;
  onRenamed: (actor: { name: string; firstName: string }) => void;
  /** The actor picked up more parts: their parts now. */
  onPartsChanged: (characters: { id: string; name: string }[]) => void;
}) {
  const toast = useToast();
  const lines = useResource(() => api.lines(), token);
  const setLinesData = lines.setData;
  const { uploader, items } = useUploads();
  const { session: stt, state: sttState } = useSttSession();
  const playback = usePlayback(() => toast("Couldn't play that. Try again."));
  const accompaniment = useAccompaniment();
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [localTakes, setLocalTakes] = useState(new Map<string, LocalTake>());
  const localTakesRef = useRef(localTakes);
  localTakesRef.current = localTakes;
  const [scores, setScores] = useState(new Map<string, Score>());
  const [view, setView] = useState<"lines" | "wrapped">("lines");
  const [announcement, setAnnouncement] = useState("");
  const [sttNotice, setSttNotice] = useState(false);
  const [scored, setScored] = useState(new Set<string>());
  const serverTakeIds = useRef(new Map<string, string>());
  const postedStt = useRef(new Set<string>());
  const stopRef = useRef<() => void>(() => {});
  /** The latest startRecording, for timers set up by an earlier render. */
  const startRef = useRef<(lineId: string) => Promise<void>>(async () => {});
  const [autoAdvance, setAutoAdvance] = useStoredFlag(AUTO_ADVANCE_KEY, true);
  const [keepRecording, setKeepRecording] = useStoredFlag(KEEP_RECORDING_KEY, false);
  /** Hear scene partners: the cue plays before each take, and on a shared line the others play along. */
  const [hearPartners, setHearPartners] = useStoredFlag(HEAR_PARTNERS_KEY, false);
  /** A line whose cue is playing before its take starts. */
  const [cueing, setCueing] = useState<string | null>(null);
  /** Client take ids deleted on this screen, so their upload no longer counts as the line's take. */
  const [deleted, setDeleted] = useState(new Set<string>());
  const [pickingUp, setPickingUp] = useState(false);

  const recorder = useTakeRecorder({
    onLimit: () => {
      toast("That take ran for an hour, so we stopped and kept it.");
      stopRef.current();
    },
  });

  const allLines: ActorLine[] = useMemo(() => lines.data?.lines ?? [], [lines.data]);
  // An actor with several parts records one at a time: only the chosen part's lines show, and
  // moving on stays within them. Remembered per invite.
  const parts = invite.characters;
  const partKey = `offbooked.part.${token}`;
  const [chosenPart, setChosenPart] = useState<string | null>(() => readStorage(partKey));
  const activePart = useMemo(() => {
    if (parts.length <= 1) return null;
    if (chosenPart && parts.some((p) => p.id === chosenPart)) return chosenPart;
    return (parts.find((p) => allLines.some((l) => saysPart(l, p.id) && !lineDone(l))) ?? parts[0]!).id;
  }, [parts, chosenPart, allLines]);
  const actorLines: ActorLine[] = useMemo(() => (activePart ? allLines.filter((l) => saysPart(l, activePart)) : allLines), [allLines, activePart]);
  /** Parts other than the one in view that still have lines needing a voice. */
  const otherParts = parts.filter((p) => p.id !== activePart).map((p) => ({ ...p, left: allLines.filter((l) => saysPart(l, p.id) && !lineDone(l)).length }));

  const live = useLiveTake({
    recording: recorder.recording,
    capture: recorder.capture,
    analyser: recorder.analyser,
    stt,
    text: actorLines.find((l) => l.line.id === recorder.recording?.lineId)?.line.text ?? "",
    autoAdvance,
    onAdvance: (_lineId, mode) => void stopRecording({ recordNext: keepRecording && mode === "live" }),
  });
  const myItems = useMemo(() => items.filter((i) => i.token === token && (i.kind ?? "invite") === "invite"), [items, token]);

  const uploadFor = useCallback(
    (lineId: string) => {
      const item = latestForLine(myItems, token, lineId);
      return item && !deleted.has(item.takeId) ? item : null;
    },
    [myItems, token, deleted],
  );
  // A line is done once it has the actor's own take, or a take by whoever had the part before
  // (it keeps playing; the actor can record over it). A stand-in or the computer voice still needs them.
  const isRecorded = useCallback(
    (lineId: string) => {
      const l = allLines.find((x) => x.line.id === lineId);
      return !!l?.take || l?.current?.source === "actor" || !!uploadFor(lineId);
    },
    [allLines, uploadFor],
  );
  const recordedCount = actorLines.filter((l) => isRecorded(l.line.id)).length;
  const total = actorLines.length;
  const allRecorded = total > 0 && recordedCount === total;
  const unsaved = myItems.filter((i) => i.status !== "saved");

  const scrollToLine = (lineId: string) => {
    cardRefs.current.get(lineId)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  /** Shows another of the actor's parts, at its first line that needs a voice. */
  const switchPart = (id: string) => {
    if (recorder.recording) return;
    playback.pause();
    setChosenPart(id);
    writeStorage(partKey, id);
    setCurrentId(null);
    setView("lines");
    window.scrollTo({ top: 0 });
  };

  // Resume at the first unrecorded line.
  useEffect(() => {
    if (currentId || actorLines.length === 0) return;
    const first = actorLines.find((l) => !lineDone(l)) ?? actorLines[0]!;
    setCurrentId(first.line.id);
    if (first !== actorLines[0]) setTimeout(() => scrollToLine(first.line.id), 100);
    if (actorLines.every(lineDone)) setView("wrapped");
    setScores((s) => {
      const next = new Map(s);
      for (const l of actorLines) if (l.take?.stt && !next.has(l.line.id)) next.set(l.line.id, { takeKey: l.take.id, result: l.take.stt });
      return next;
    });
  }, [actorLines, currentId]);

  // Karaoke-style follow while a take records: the next word to say stays near the middle of the
  // screen, with a few rows of what's coming below it. A scroll by hand pauses it for a moment.
  const scrolledAt = useRef(0);
  useEffect(() => {
    const mark = () => (scrolledAt.current = performance.now());
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("wheel", mark, { passive: true });
    return () => {
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("wheel", mark);
    };
  }, []);
  const liveLine = live?.lineId;
  const liveCursor = live?.mode === "live" ? live.cursor : null;
  useEffect(() => {
    if (!recorder.recording || !liveLine || liveCursor === null) return;
    if (performance.now() - scrolledAt.current < 2500) return;
    const card = cardRefs.current.get(liveLine);
    const el = card?.querySelector(".lw-next") ?? [...(card?.querySelectorAll(".lw-lit") ?? [])].pop();
    if (el) keepInView(el, null, recorderBand);
  }, [recorder.recording, liveLine, liveCursor]);

  const postStt = useCallback(
    (clientTakeId: string, result: SttResult) => {
      const serverId = serverTakeIds.current.get(clientTakeId);
      if (!serverId || postedStt.current.has(clientTakeId)) return;
      postedStt.current.add(clientTakeId);
      api.postStt(serverId, result).catch(() => postedStt.current.delete(clientTakeId));
    },
    [api],
  );

  const scoresRef = useRef(scores);
  scoresRef.current = scores;

  // When a take lands: remember the server's take, start the speech model after the first one, post any score.
  useEffect(
    () =>
      uploader.onSaved((item, result) => {
        if (item.token !== token || item.kind === "director") return;
        serverTakeIds.current.set(item.takeId, result.take.id);
        setLinesData((current) => ({
          sections: current?.sections ?? [],
          lines: (current?.lines ?? []).map((l) => (l.line.id === item.lineId ? { ...l, take: result.take } : l)),
        }));
        void stt.start();
        const score = scoresRef.current.get(item.lineId);
        if (score?.takeKey === item.takeId) postStt(item.takeId, score.result);
      }),
    [uploader, token, setLinesData, stt, postStt],
  );

  // Live word highlighting needs the model. InvitePage (and the cast link before it) has usually
  // started loading it already; this covers a recorder opened any other way. Takes never wait for
  // it, and `start` still declines on data saver or an unsupported device.
  useEffect(() => {
    void stt.start();
  }, [stt]);

  useEffect(() => {
    if (sttState.status === "unavailable" && stt.claimUnavailableNotice()) setSttNotice(true);
  }, [sttState.status, stt]);

  useEffect(() => () => localTakesRef.current.forEach((t) => URL.revokeObjectURL(t.url)), []);

  const nextUnrecorded = (afterId: string, justRecorded: string): string | null => {
    const index = actorLines.findIndex((l) => l.line.id === afterId);
    const ordered = [...actorLines.slice(index + 1), ...actorLines.slice(0, index + 1)];
    return ordered.find((l) => l.line.id !== justRecorded && !isRecorded(l.line.id))?.line.id ?? null;
  };

  const startRecording = async (lineId: string) => {
    if (recorder.recording || cueing) return;
    playback.pause();
    setCurrentId(lineId);
    const item = actorLines.find((l) => l.line.id === lineId);
    if (hearPartners && item?.cue?.audioUrl) {
      // Hear the cue first, like on stage; a tap on record skips the rest of it.
      setCueing(lineId);
      setAnnouncement(`Listening to ${item.cue.characterName}'s cue.`);
      await accompaniment.playThrough(item.cue.audioUrl);
      setCueing(null);
    }
    if (!(await recorder.start(lineId))) return;
    setAnnouncement("Recording. Say your line, then tap stop.");
    const others = (item?.together ?? []).flatMap((t) => (t.audioUrl ? [t.audioUrl] : []));
    if (hearPartners && others.length) accompaniment.start(others);
  };

  /** Deletes the line's take, with Undo. The line goes back to the previous take, if any. */
  const deleteTake = async (lineId: string, serverId: string) => {
    playback.pause();
    const local = localTakes.get(lineId);
    try {
      await api.deleteTake(serverId);
    } catch (err) {
      toast(errorMessage(err));
      return;
    }
    if (local) setDeleted((d) => new Set(d).add(local.clientTakeId));
    setLocalTakes((m) => {
      const next = new Map(m);
      next.delete(lineId);
      return next;
    });
    setScores((s) => {
      const next = new Map(s);
      next.delete(lineId);
      return next;
    });
    const refreshed = await api.lines().catch(() => null);
    if (refreshed) setLinesData(refreshed);
    setAnnouncement("Take deleted.");
    toast("Take deleted", {
      label: "Undo",
      onClick: async () => {
        try {
          await api.restoreTake(serverId);
          if (local) {
            setDeleted((d) => {
              const next = new Set(d);
              next.delete(local.clientTakeId);
              return next;
            });
          }
          const back = await api.lines();
          setLinesData(back);
          const take = back.lines.find((l) => l.line.id === lineId)?.take;
          if (take?.stt) setScores((s) => new Map(s).set(lineId, { takeKey: take.id, result: take.stt! }));
        } catch (err) {
          toast(errorMessage(err));
        }
      },
    });
  };

  startRef.current = startRecording;

  /** Stops and keeps the take, then moves to the next line; hands-free mode records the next line too. */
  const stopRecording = async ({ recordNext = false }: { recordNext?: boolean } = {}) => {
    const lineId = recorder.recording?.lineId;
    accompaniment.stop();
    const recorded = await recorder.stop();
    if (!recorded || !lineId) return;
    if (recorded.tooShort) {
      setAnnouncement("That was too short. Tap record and say your line.");
      toast("Too short. Tap record, say your line, then tap stop.");
      return;
    }
    const url = URL.createObjectURL(recorded.blob);
    let clientTakeId: string;
    try {
      clientTakeId = await uploader.add({ token, lineId, audio: recorded.blob, durationMs: recorded.durationMs });
    } catch {
      URL.revokeObjectURL(url);
      toast("Couldn't save that take on this device. Try again.");
      return;
    }
    setLocalTakes((m) => {
      const next = new Map(m);
      const old = next.get(lineId);
      if (old) URL.revokeObjectURL(old.url);
      next.set(lineId, { clientTakeId, url, durationMs: recorded.durationMs });
      return next;
    });
    setScores((s) => {
      const next = new Map(s);
      next.delete(lineId);
      return next;
    });
    setAnnouncement("Take saved.");

    const text = actorLines.find((l) => l.line.id === lineId)?.line.text ?? "";
    void stt.score(lineId, recorded.blob, text).then((result) => {
      setScored((set) => new Set(set).add(clientTakeId));
      if (!result) return;
      setScores((s) => new Map(s).set(lineId, { takeKey: clientTakeId, result }));
      postStt(clientTakeId, result);
    });

    goToNext(lineId, recordNext);
  };
  stopRef.current = () => void stopRecording();

  const goToNext = (lineId: string, recordNext = false) => {
    const next = nextUnrecorded(lineId, lineId);
    setTimeout(() => {
      if (next) {
        setCurrentId(next);
        scrollToLine(next);
        if (recordNext) void startRef.current(next);
      } else {
        setView("wrapped");
        window.scrollTo({ top: 0 });
      }
    }, ADVANCE_DELAY_MS);
  };

  /** After picking up parts: reload the lines and show the new part, at its first line that needs a voice. */
  const afterPickUp = async (characters: { id: string; name: string }[]) => {
    setPickingUp(false);
    const added = characters.find((c) => !parts.some((p) => p.id === c.id));
    if (added) {
      setChosenPart(added.id);
      writeStorage(partKey, added.id);
    }
    onPartsChanged(characters);
    const fresh = await api.lines().catch(() => null);
    if (!fresh) return void lines.reload();
    setLinesData(fresh);
    setView("lines");
    setCurrentId(null);
    toast("Picked up. Your new lines are in the list.");
  };

  if (lines.loading) return <Loading />;
  if (lines.error || !lines.data) {
    return (
      <main className="page page-narrow center-page">
        <p role="alert">{errorMessage(lines.error)}</p>
        <button className="btn btn-primary" onClick={() => void lines.reload()}>
          Try again
        </button>
      </main>
    );
  }

  const sections = lines.data.sections;
  const characterNames = new Map(invite.characters.map((c) => [c.id, c.name]));
  // A shared line is said as the actor's own character(s) among its voices.
  const speakerFor = (l: ActorLine) =>
    l.line.voiceIds
      ? l.line.voiceIds.flatMap((id) => characterNames.get(id) ?? []).join(" & ") || (characterNames.get(l.line.characterId ?? "") ?? "")
      : (characterNames.get(l.line.characterId ?? "") ?? "");
  // The take that Delete removes: the one just saved here, else the actor's own latest.
  const deletableTake = (l: ActorLine): string | null => {
    const local = localTakes.get(l.line.id);
    if (local) return serverTakeIds.current.get(local.clientTakeId) ?? null;
    return l.take?.id ?? null;
  };
  const current = actorLines.find((l) => l.line.id === currentId) ?? null;
  const progressLabel = `${Math.min(recordedCount + (allRecorded ? 0 : 1), total)} of ${total}`;
  const failed = unsaved.filter((i) => i.status === "failed");

  if (view === "wrapped") {
    return (
      <div className="actor-shell">
        <header className="actor-header">
          <Brand to={`/i/${token}`} />
        </header>
        <Wrapped
          token={token}
          api={api}
          invite={invite}
          lines={actorLines}
          scores={scores}
          sttState={sttState}
          unsaved={unsaved}
          pendingScores={sttState.status === "unavailable" ? 0 : [...localTakes.values()].filter((t) => !scored.has(t.clientTakeId)).length}
          onRetry={(id) => uploader.retry(id)}
          onPickedUp={(characters) => void afterPickUp(characters)}
          partId={activePart}
          otherParts={otherParts}
          onSwitchPart={switchPart}
          onReview={(lineId) => {
            setView("lines");
            setCurrentId(lineId);
            setTimeout(() => scrollToLine(lineId), 50);
          }}
        />
      </div>
    );
  }

  return (
    <div className="actor-shell recorder">
      <header className="record-header">
        <div className="record-header-row">
          <div className="grow">
            <p className="record-title">
              {invite.production.title}
              <NameEditor name={invite.actor.name} onSave={async (name) => onRenamed((await api.rename(name)).actor)} />
            </p>
            <p className="record-progress" aria-live="polite">
              {allRecorded ? (
                `All ${total} recorded`
              ) : (
                <>
                  Line <span className="nums">{progressLabel}</span>
                </>
              )}
            </p>
          </div>
          <SttChip state={sttState} onEnable={() => stt.enable()} />
          <button type="button" className="icon-btn" onClick={() => setPickingUp(true)} aria-label="Pick up more lines" title="Pick up more lines">
            <Plus size={22} />
          </button>
          {recordedCount > 0 && (
            <Link className="icon-btn" to={`/i/${token}/play${activePart ? `?part=${activePart}` : ""}`} aria-label="Listen to the run-through">
              <Headphones size={22} />
            </Link>
          )}
        </div>
        <ProgressBar value={recordedCount} max={total} label="Lines recorded" />
        {activePart && (
          <div className="part-switch" role="group" aria-label="Part to record">
            {parts.map((p) => {
              const own = allLines.filter((l) => saysPart(l, p.id));
              const left = own.filter((l) => !isRecorded(l.line.id)).length;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="part-chip"
                  aria-pressed={p.id === activePart}
                  disabled={!!recorder.recording}
                  onClick={() => switchPart(p.id)}
                >
                  <CharacterName name={p.name} />
                  <span className="part-chip-meta small">{left === 0 ? "✓ done" : `${left} to go`}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      <main className="record-main">
        <InAppBanner />
        {sttNotice && (
          <p className="notice small" role="status">
            Accuracy check isn't available on this device. Your recordings work as normal.
          </p>
        )}
        {failed.length > 0 && (
          <div className="notice notice-error" role="alert">
            <span className="grow">
              {failed.length === 1 ? "A take" : `${failed.length} takes`} didn't upload. {failed[0]!.error}
            </span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => failed.forEach((f) => uploader.retry(f.takeId))}>
              Retry
            </button>
          </div>
        )}
        {total === 0 && (
          <section className="card stack empty-parts">
            <h2 className="display">No lines right now</h2>
            <PickUpParts api={api} onPicked={(c) => void afterPickUp(c)} intro="Your director has moved your part on. Pick up a free part to keep recording." />
          </section>
        )}
        <SectionNav sections={sections} idPrefix="rec-section-" />

        {sections.map((section) => {
          const inSection = actorLines.filter((l) => l.line.sectionId === section.id);
          if (inSection.length === 0) return null;
          return (
            <section key={section.id} id={`rec-section-${section.id}`} className="record-section">
              <h2 className="eyebrow">{section.title}</h2>
              <ol className="line-list">
                {inSection.map((l) => (
                  <li
                    key={l.line.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(l.line.id, el);
                      else cardRefs.current.delete(l.line.id);
                    }}
                  >
                    <LineCard
                      actorLine={l}
                      speaker={speakerFor(l)}
                      number={actorLines.indexOf(l) + 1}
                      total={total}
                      current={l.line.id === currentId}
                      recording={recorder.recording?.lineId === l.line.id}
                      localTake={localTakes.get(l.line.id) ?? null}
                      upload={uploadFor(l.line.id)}
                      score={scores.get(l.line.id) ?? null}
                      playing={playback.playing}
                      liveCursor={live?.lineId === l.line.id && live.mode === "live" ? live.cursor : null}
                      liveHint={live?.lineId === l.line.id ? liveHint(live.mode, autoAdvance, keepRecording) : undefined}
                      progress={playback.progress}
                      onPlay={playback.play}
                      onPlayTogether={playback.playTogether}
                      onDelete={deletableTake(l) ? () => void deleteTake(l.line.id, deletableTake(l)!) : undefined}
                      onSelect={() => !recorder.recording && setCurrentId(l.line.id)}
                      onRerecord={() => void startRecording(l.line.id)}
                      onRetry={(id) => uploader.retry(id)}
                    />
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
        {allRecorded && (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => setView("wrapped")}>
            Done for now
          </button>
        )}
      </main>

      <RecordDock
        recording={!!recorder.recording}
        elapsed={recorder.elapsed}
        analyser={recorder.analyser}
        micStatus={recorder.micStatus}
        micError={recorder.micError}
        hint={
          cueing
            ? "Listening to the cue… tap to start now."
            : current && isRecorded(current.line.id)
              ? "Recorded. Tap to record it again."
              : autoAdvance
                ? "Tap, then say your line."
                : "Tap, say your line, tap to stop."
        }
        disabled={!current}
        label={current ? `Record line ${actorLines.indexOf(current) + 1}` : "Record"}
        onToggle={() => (cueing ? accompaniment.stop() : recorder.recording ? void stopRecording() : current && void startRecording(current.line.id))}
        onRetry={() => currentId && void startRecording(currentId)}
      >
        <div className="dock-options">
          <label className="checkbox dock-option">
            <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
            Auto-advance
          </label>
          <label className={`checkbox dock-option${autoAdvance ? "" : " is-off"}`}>
            <input type="checkbox" checked={keepRecording} disabled={!autoAdvance} onChange={(e) => setKeepRecording(e.target.checked)} />
            Keep recording
          </label>
          <label className="checkbox dock-option" title="Plays the cue before each line, and the others' takes during shared lines. Wear headphones.">
            <input type="checkbox" checked={hearPartners} onChange={(e) => setHearPartners(e.target.checked)} />
            Hear partners
          </label>
        </div>
      </RecordDock>
      <Dialog open={pickingUp} onClose={() => setPickingUp(false)} title="Pick up more lines">
        {pickingUp && <PickUpParts api={api} onPicked={(c) => void afterPickUp(c)} />}
      </Dialog>
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
    </div>
  );
}

function liveHint(mode: "live" | "energy", autoAdvance: boolean, keepRecording: boolean): string | undefined {
  if (!autoAdvance) return mode === "live" ? "Tap stop when you're done." : undefined;
  if (mode === "energy") return "Moves on after a pause.";
  return keepRecording ? "Moves on and keeps recording when you finish." : "Moves on when you finish the line.";
}

function SttChip({ state, onEnable }: { state: ReturnType<typeof useSttSession>["state"]; onEnable: () => void }) {
  if (state.status === "optin") {
    return (
      <button type="button" className="chip" onClick={onEnable}>
        Turn on accuracy check ({state.downloadMb} MB)
      </button>
    );
  }
  if (state.status !== "loading" && state.status !== "checking") return null;
  // Real download progress; after the last byte the model still takes a moment to start.
  const percent = state.progress !== null && state.progress < 1 ? Math.floor(state.progress * 100) : null;
  return (
    <span className="chip stt-chip" role="status">
      <span className="spinner spinner-xs" aria-hidden="true" />
      <span className="stt-chip-long">Getting the accuracy check ready…</span>
      <span className="stt-chip-short">Accuracy check</span>
      {percent !== null && <span className="nums">{percent}%</span>}
    </span>
  );
}

/** Whether a line belongs to a part: its speaker, or one of a shared line's voices. */
function saysPart(l: ActorLine, characterId: string): boolean {
  return l.line.characterId === characterId || (l.line.voiceIds ?? []).includes(characterId);
}

/** A line with the actor's own take, or an earlier cast member's that keeps playing. */
function lineDone(l: ActorLine): boolean {
  return !!l.take || l.current?.source === "actor";
}
