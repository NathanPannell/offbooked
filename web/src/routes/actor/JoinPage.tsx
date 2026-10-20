import { ArrowRight, Check } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { join } from "../../api/join";
import type { JoinInfo } from "../../api/types";
import { Brand } from "../../components/Brand";
import { CharacterName } from "../../components/CharacterName";
import { InAppBanner } from "../../components/InAppBanner";
import { Loading } from "../../components/Loading";
import { joinNames, plural } from "../../lib/format";
import { recallJoin, rememberJoin } from "../../lib/joinMemory";
import { recorderDescription, recorderLabel } from "../../lib/recorders";
import { usePrewarmStt } from "../../stt/useStt";
import { Onboarding, onboardingSeen } from "./Onboarding";

const RETRY_MS = 10_000;

/**
 * The whole-cast link: see the parts, pick yours, give a first name, start recording. Parts aren't
 * owned: any part can be picked, even one someone else is recording (or yours, again, on a new phone).
 */
export default function JoinPage() {
  const { token = "" } = useParams();
  const remembered = useMemo(() => recallJoin(token), [token]);
  if (remembered) return <Navigate to={`/i/${remembered.inviteToken}`} replace />;
  return <Join token={token} />;
}

function Join({ token }: { token: string }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  // First time on this device: a short intro before picking a part (skippable).
  const [intro, setIntro] = useState(() => !onboardingSeen());
  // Load the speech model while they pick a part and type a name, so it is ready by the first take.
  usePrewarmStt(!!info?.characters.length);

  useEffect(() => {
    let cancelled = false;
    join.get(token).then(
      (result) => {
        if (cancelled) return;
        setInfo(result);
        setError(null);
        // Drop any pick that's no longer a part (merged into another meanwhile).
        setPicked((p) => new Set([...p].filter((id) => result.characters.some((c) => c.id === id))));
      },
      (err) => !cancelled && setError(err),
    );
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const notReady = error instanceof ApiError && error.status === 409;
  useEffect(() => {
    if (!notReady) return;
    const id = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
    return () => clearTimeout(id);
  }, [notReady, attempt]);

  if (!info && !error) return <Loading />;

  if (error && !info) {
    const body = error instanceof ApiError ? error.body : null;
    const director = typeof body?.directorName === "string" ? body.directorName : null;
    const title = typeof body?.productionTitle === "string" ? body.productionTitle : null;
    if (notReady) {
      return (
        <JoinMessage title={title ? `${title} is nearly ready` : "Nearly ready"}>
          <p>{director ?? "Your director"} is still preparing the script. This page checks again by itself, so you can leave it open.</p>
          <div className="row waiting" role="status">
            <span className="spinner" aria-hidden="true" /> Checking every few seconds…
          </div>
        </JoinMessage>
      );
    }
    if (error instanceof ApiError && error.status === 410) {
      return (
        <JoinMessage title="This show has wrapped">
          <p>{title ? `${title} has closed, so this link no longer works.` : "This link no longer works."}</p>
        </JoinMessage>
      );
    }
    if (error instanceof ApiError && error.status === 404) {
      return (
        <JoinMessage title="This link doesn't work">
          <p>It may have been reset, or it's missing a few characters. Ask your director for the cast link again.</p>
        </JoinMessage>
      );
    }
    return (
      <JoinMessage title="We couldn't open this">
        <p role="alert">{errorMessage(error)}</p>
        <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </JoinMessage>
    );
  }

  const data = info!;
  if (intro && data.characters.length > 0) {
    return <Onboarding productionTitle={data.production.title} directorName={data.production.directorName} onDone={() => setIntro(false)} />;
  }
  const chosen = data.characters.filter((c) => picked.has(c.id));
  const lines = chosen.reduce((n, c) => n + c.lineCount, 0);

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const claim = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen.length || !name.trim()) return;
    setBusy(true);
    setClaimError(null);
    try {
      const { inviteToken } = await join.claim(token, { characterIds: chosen.map((c) => c.id), firstName: name.trim() });
      rememberJoin(token, { inviteToken, firstName: name.trim(), characterNames: chosen.map((c) => c.name) });
      navigate(`/i/${inviteToken}`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) {
        setError(err);
        setInfo(null);
      } else {
        setClaimError(errorMessage(err));
        // A part may have been merged into another meanwhile: refresh the list (stale picks drop).
        if (err instanceof ApiError && err.status === 400) setAttempt((n) => n + 1);
      }
    }
  };

  return (
    <main className="join">
      <InAppBanner />
      <header className="join-head">
        <Brand to={null} />
        <p className="eyebrow">{data.production.directorName} invited you</p>
        <h1 className="display">{data.production.title}</h1>
        <p className="lede">Which part are you playing? Pick yours (or more than one, if you're doubling).</p>
      </header>

      <form className="join-form" onSubmit={claim}>
        <fieldset className="role-cards">
          <legend className="sr-only">Characters</legend>
          {data.characters.map((c) => {
            const on = picked.has(c.id);
            const by = recorderLabel(c.topRecorder);
            return (
              <label key={c.id} className={`role-card ${on ? "is-picked" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(c.id)}
                  className="sr-only"
                  aria-label={`${c.name}, ${plural(c.lineCount, "line")}, ${c.linesRecorded} recorded, ${recorderDescription(c.topRecorder)}`}
                />
                <span className="role-check" aria-hidden="true">
                  {on && <Check size={14} strokeWidth={3.5} />}
                </span>
                <span className="role-name">
                  <CharacterName name={c.name} />
                </span>
                <span className="role-meta small nums" aria-hidden="true">
                  {plural(c.lineCount, "line")}
                  {c.linesRecorded > 0 && ` · ${c.linesRecorded} recorded`}
                </span>
                {by && (
                  <span className="role-by small" aria-hidden="true">
                    {by}
                  </span>
                )}
              </label>
            );
          })}
        </fieldset>

        <div className={`join-dock ${chosen.length ? "is-ready" : ""}`}>
          {chosen.length > 0 ? (
            <>
              <p className="join-summary">
                You're <strong>{joinNames(chosen.map((c) => c.name))}</strong> · <span className="nums">{plural(lines, "line")}</span>
              </p>
              <label className="field">
                <span>Your first name</span>
                <input
                  className="input input-lg"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="given-name"
                  enterKeyHint="go"
                  maxLength={60}
                  required
                />
              </label>
              {claimError && (
                <p className="field-error" role="alert">
                  {claimError}
                </p>
              )}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()}>
                {busy ? "Getting your lines…" : "Start recording"} <ArrowRight size={18} aria-hidden="true" />
              </button>
              <p className="small muted consent">Your recordings are shared with the cast and director. No account needed.</p>
            </>
          ) : (
            <p className="join-summary muted">Tap your character to begin.</p>
          )}
          {claimError && !chosen.length && (
            <p className="field-error" role="alert">
              {claimError}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}

function JoinMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page page-narrow center-page join-message">
      <Brand to="/" />
      <div className="raised message-card stack">
        <h1 className="display">{title}</h1>
        {children}
      </div>
    </main>
  );
}
