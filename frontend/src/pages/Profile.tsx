import { useState, type FormEvent } from "react";
import { api, errorOf, type Me } from "../api.js";
import { Gate } from "../components/Gate.js";
import { navigate } from "../nav.js";

// Asked once, right after sign-in, before the first trade; editable later on the account page.
const HANDLE = /^[a-z0-9_]{3,20}$/;
const suggest = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);

export function ProfileForm({ me, onSaved, submitLabel }: { me: Me; onSaved: (me: Me) => void; submitLabel: string }) {
  const [name, setName] = useState(me.displayName);
  const [handle, setHandle] = useState(me.handle ?? suggest(me.displayName));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const handleOk = HANDLE.test(handle);
  const unchanged = me.profileComplete && name.trim() === me.displayName && handle === me.handle;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await api<Me>("PUT", "/me/profile", { displayName: name.trim(), handle }));
      setMessage({ text: "Profile saved.", error: false });
    } catch (err) {
      setMessage({ text: errorOf(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={save}>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="name" required />
      </label>
      <label>
        Handle
        <span className="handle-field">
          <span className="handle-at" aria-hidden>
            @
          </span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            maxLength={20}
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={handle.length > 0 && !handleOk}
            aria-describedby="handle-help"
            required
          />
        </span>
        <span id="handle-help" className={`help${handle.length > 0 && !handleOk ? " error" : ""}`}>
          3 to 20 characters: lowercase letters, numbers and _
        </span>
      </label>
      {message && (
        <p className={`notice${message.error ? " error" : ""}`} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <button className="button primary" disabled={busy || !handleOk || !name.trim() || unchanged}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function Profile({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  return (
    <Gate>
      <h1>Set up your profile</h1>
      <p className="gate-lede">One step before you trade: choose your name and handle.</p>
      <ProfileForm
        me={me}
        submitLabel="Start trading"
        onSaved={(m) => {
          onSaved(m);
          navigate("/", true);
        }}
      />
    </Gate>
  );
}
