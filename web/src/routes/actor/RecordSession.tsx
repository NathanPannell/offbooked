import { Headphones } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { ActorApi } from "../../api/actor";
import { errorMessage } from "../../api/client";
import type { ActorLine, Invite, SttResult } from "../../api/types";
import { usePlayback, useTakeRecorder } from "../../audio/useTakeRecorder";
import { Brand } from "../../components/Brand";
import { InAppBanner } from "../../components/InAppBanner";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { RecordDock } from "../../components/RecordDock";
import { SectionNav } from "../../components/SectionNav";
import { useToast } from "../../components/Toast";
import { useResource } from "../../lib/useResource";
import { useSttSession } from "../../stt/useStt";
import { latestForLine } from "../../upload/queue";
import { useUploads } from "../../upload/useUploads";
import { LineCard, type LocalTake } from "./LineCard";
import { Wrapped } from "./Wrapped";

const ADVANCE_DELAY_MS = 700;

export interface Score {
  takeKey: string;
  result: SttResult;
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function RecordSession({ token, api, invite }: { token: string; api: ActorApi; invite: Invite }) {
  const toast = useToast();
  const lines = useResource(() => api.lines(), token);
  const setLinesData = lines.setData;
  const { uploader, items } = useUploads();
  const { session: stt, state: sttState } = useSttSession();
  const playback = usePlayback(() => toast("Couldn't play that. Try again."));
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

  const recorder = useTakeRecorder({
    onLimit: () => {
      toast("That's the 2 minute limit, so we stopped there.");
      stopRef.current();
    },
  });

  const actorLines: ActorLine[] = useMemo(() => lines.data?.lines ?? [], [lines.data]);
  const myItems = useMemo(() => items.filter((i) => i.token === token && (i.kind ?? "invite") === "invite"), [items, token]);

  const isRecorded = useCallback(
    (lineId: string) => !!actorLines.find((l) => l.line.id === lineId)?.take || !!latestForLine(myItems, token, lineId),
    [actorLines, myItems, token],
  );
  const recordedCount = actorLines.filter((l) => isRecorded(l.line.id)).length;
  const total = actorLines.length;
  const allRecorded = total > 0 && recordedCount === total;
  const unsaved = myItems.filter((i) => i.status !== "saved");

  const scrollToLine = (lineId: string) => {
    cardRefs.current.get(lineId)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  // Resume at the first unrecorded line.
  useEffect(() => {
    if (currentId || actorLines.length === 0) return;
    const first = actorLines.find((l) => !l.take) ?? actorLines[0]!;
    setCurrentId(first.line.id);
    if (first !== actorLines[0]) setTimeout(() => scrollToLine(first.line.id), 100);
    if (actorLines.every((l) => l.take)) setView("wrapped");
    setScores((s) => {
      const next = new Map(s);
      for (const l of actorLines) if (l.take?.stt && !next.has(l.line.id)) next.set(l.line.id, { takeKey: l.take.id, result: l.take.stt });
      return next;
    });
  }, [actorLines, currentId]);

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
    if (recorder.recording) return;
    playback.pause();
    setCurrentId(lineId);
    if (await recorder.start(lineId)) setAnnouncement("Recording. Say your line, then tap stop.");
  };

  const stopRecording = async () => {
    const lineId = recorder.recording?.lineId;
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

    const next = nextUnrecorded(lineId, lineId);
    setTimeout(() => {
      if (next) {
        setCurrentId(next);
        scrollToLine(next);
      } else {
        setView("wrapped");
        window.scrollTo({ top: 0 });
      }
    }, ADVANCE_DELAY_MS);
  };
  stopRef.current = () => void stopRecording();

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
            <p className="record-title">{invite.production.title}</p>
            <p className="record-progress" aria-live="polite">
              {allRecorded ? `All ${total} recorded` : (
                <>
                  Line <span className="nums">{progressLabel}</span>
                </>
              )}
            </p>
          </div>
          <SttChip state={sttState} onEnable={() => stt.enable()} />
          {recordedCount > 0 && (
            <Link className="icon-btn" to={`/i/${token}/play`} aria-label="Listen to the run-through">
              <Headphones size={22} />
            </Link>
          )}
        </div>
        <ProgressBar value={recordedCount} max={total} label="Lines recorded" />
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
                      speaker={characterNames.get(l.line.characterId ?? "") ?? ""}
                      number={actorLines.indexOf(l) + 1}
                      total={total}
                      current={l.line.id === currentId}
                      recording={recorder.recording?.lineId === l.line.id}
                      localTake={localTakes.get(l.line.id) ?? null}
                      upload={latestForLine(myItems, token, l.line.id)}
                      score={scores.get(l.line.id) ?? null}
                      playing={playback.playing}
                      onPlay={playback.play}
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
        hint={current && isRecorded(current.line.id) ? "Recorded. Tap to record it again." : "Tap, say your line, tap to stop."}
        disabled={!current}
        label={current ? `Record line ${actorLines.indexOf(current) + 1}` : "Record"}
        onToggle={() => (recorder.recording ? void stopRecording() : current && void startRecording(current.line.id))}
        onRetry={() => currentId && void startRecording(currentId)}
      />
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
    </div>
  );
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
  return (
    <span className="chip stt-chip" role="status">
      <span className="spinner spinner-xs" aria-hidden="true" />
      Accuracy check warming up{state.progress ? ` ${Math.round(state.progress * 100)}%` : "…"}
    </span>
  );
}
