import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { actorApi } from "../../api/actor";
import { ApiError, errorMessage } from "../../api/client";
import type { Invite } from "../../api/types";
import { Brand } from "../../components/Brand";
import { CharacterName } from "../../components/CharacterName";
import { InAppBanner } from "../../components/InAppBanner";
import { Loading } from "../../components/Loading";
import { firstWord, joinNames, plural } from "../../lib/format";
import { forgetJoin, joinTokenForInvite } from "../../lib/joinMemory";
import { useResource } from "../../lib/useResource";
import { RecordSession } from "./RecordSession";

export default function InvitePage() {
  const { token = "" } = useParams();
  const api = useMemo(() => actorApi(token), [token]);
  const invite = useResource(() => api.invite(), token);
  const [started, setStarted] = useState(false);

  if (invite.loading) return <Loading />;
  if (invite.error instanceof ApiError && (invite.error.status === 410 || invite.error.status === 401 || invite.error.status === 404)) {
    return <LinkGone body={invite.error.body} token={token} />;
  }
  if (invite.error || !invite.data) {
    return (
      <main className="page page-narrow center-page">
        <Brand to={null} />
        <p role="alert">{errorMessage(invite.error)}</p>
        <button className="btn btn-primary" onClick={() => void invite.reload()}>
          Try again
        </button>
      </main>
    );
  }

  const data = invite.data;
  const alreadyStarted = started || data.actor.firstName !== null || data.linesRecorded > 0;
  if (!alreadyStarted) return <Welcome invite={data} onStart={async (firstName) => {
    await api.start(firstName);
    setStarted(true);
  }} />;
  return <RecordSession token={token} api={api} invite={data} />;
}

function Welcome({ invite, onStart }: { invite: Invite; onStart: (firstName: string) => Promise<void> }) {
  const [name, setName] = useState(invite.actor.firstName ?? firstWord(invite.actor.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = invite.characters.map((c) => c.name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onStart(name.trim());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="welcome">
      <InAppBanner />
      <div className="marquee">
        <p className="eyebrow marquee-eyebrow">{invite.production.title}</p>
        <h1 className="marquee-title">
          <span className="marquee-youre">You're</span>{" "}
          {roles.map((r, i) => (
            <span key={r}>
              {i > 0 && (i === roles.length - 1 ? " & " : ", ")}
              <CharacterName name={r} className="marquee-role" />
            </span>
          ))}
        </h1>
        <p className="marquee-meta">
          {invite.production.directorName} invited you to record {plural(invite.linesTotal, "line")}. It takes a few
          minutes.
        </p>
      </div>

      <form className="welcome-form stack" onSubmit={submit}>
        <label className="field">
          <span>Your first name</span>
          <input
            className="input input-lg"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="given-name"
            required
            enterKeyHint="go"
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()}>
          {busy ? "Starting…" : "Start"}
        </button>
        <p className="small muted consent">
          Your recordings are shared with the cast and director of {invite.production.title}. No account needed.
        </p>
      </form>
      <span className="sr-only">You're playing {joinNames(roles)}.</span>
    </main>
  );
}

function LinkGone({ body, token }: { body: Record<string, unknown> | null; token: string }) {
  const director = typeof body?.directorName === "string" ? body.directorName : null;
  const title = typeof body?.productionTitle === "string" ? body.productionTitle : null;
  // Came here through the cast link on this device? Offer to pick a part again.
  const joinToken = joinTokenForInvite(token);
  return (
    <main className="page page-narrow center-page">
      <Brand to={null} />
      <div className="sticker message-card stack">
        <h1 className="display">This link has closed</h1>
        <p>
          {title ? `The link for ${title} ` : "This link "}has expired or been replaced.{" "}
          {director ? `Ask ${director} for a fresh one.` : "Ask your director for a fresh one."}
        </p>
        {joinToken && (
          <a
            className="btn btn-primary"
            href={`/join/${joinToken}`}
            onClick={() => forgetJoin(joinToken)}
          >
            Pick your part again
          </a>
        )}
      </div>
    </main>
  );
}
