import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { cast as castApi } from "../../api/director";
import type { CastMember, Character } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";

export function ActorForm({
  productionId,
  member,
  initialCharacterIds,
  characters,
  castMembers,
  onSaved,
}: {
  productionId: string;
  member?: CastMember;
  initialCharacterIds: string[];
  characters: Character[];
  castMembers: CastMember[];
  onSaved: (member: CastMember, created: boolean) => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [selected, setSelected] = useState(new Set(initialCharacterIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playedBy = new Map<string, string>();
  for (const m of castMembers) {
    if (m.id !== member?.id) m.characterIds.forEach((id) => playedBy.set(id, m.name));
  }
  const sorted = [...characters].sort((a, b) => b.lineCount - a.lineCount);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      characterIds: [...selected],
    };
    try {
      const result = member ? await castApi.update(member.id, input) : await castApi.create(productionId, input);
      onSaved(result.member, !member);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Actor's name</span>
        <input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus={!member} />
      </label>
      <fieldset className="stack role-picker" style={{ gap: 4 }}>
        <legend className="field-label">Plays</legend>
        {sorted.map((c) => {
          const other = playedBy.get(c.id);
          return (
            <label key={c.id} className="checkbox">
              <input type="checkbox" checked={selected.has(c.id)} disabled={!!other} onChange={() => toggle(c.id)} />
              <CharacterName name={c.name} />
              <span className="small muted">{other ? `played by ${other}` : `${c.lineCount} lines`}</span>
            </label>
          );
        })}
      </fieldset>
      <label className="field">
        <span>Email (optional)</span>
        <input className="input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <span className="field-hint">Only used to tell them when the run-through is ready.</span>
      </label>
      <label className="field">
        <span>Phone (optional)</span>
        <input className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <span className="field-hint">Kept for your records. Offbooked never texts anyone.</span>
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy || !name.trim() || selected.size === 0}>
        {busy ? "Saving…" : member ? "Save" : "Add to cast"}
      </button>
    </form>
  );
}
