import { Check, Pencil, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { useToast } from "../../components/Toast";

/** "as Riz ✎": the actor's name on the recorder, editable in place for a typo made when joining. */
export function NameEditor({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (!next || next === name) return setEditing(false);
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
      toast("Name saved");
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="name-edit-toggle"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
        aria-label={`Recording as ${name}. Change your name`}
      >
        as {name} <Pencil size={12} aria-hidden="true" />
      </button>
    );
  }
  return (
    <form className="name-edit" onSubmit={submit}>
      <label className="sr-only" htmlFor="actor-name">
        Your name
      </label>
      <input
        id="actor-name"
        className="input input-sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        maxLength={60}
        autoComplete="given-name"
        autoFocus
      />
      <button className="icon-btn" disabled={busy || !value.trim()} aria-label="Save your name">
        <Check size={16} />
      </button>
      <button type="button" className="icon-btn" onClick={() => setEditing(false)} aria-label="Cancel">
        <X size={16} />
      </button>
    </form>
  );
}
