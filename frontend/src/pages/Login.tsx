import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "../api.js";
import { Gate } from "../components/Gate.js";

const providers: Record<string, { name: string; icon: ReactNode }> = {
  google: {
    name: "Google",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.4 1.1-4.1 1.1-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.2a7.2 7.2 0 0 1 0-4.6V6.5h-4a12 12 0 0 0 0 10.8l4-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.5l4 3.1c.9-2.8 3.6-4.8 6.7-4.8z" />
      </svg>
    ),
  },
  github: {
    name: "GitHub",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
        />
      </svg>
    ),
  },
};

export function Login() {
  const [available, setAvailable] = useState<string[] | null>(null);
  const error = new URLSearchParams(location.search).get("error");

  useEffect(() => {
    api<{ providers: string[] }>("GET", "/auth/providers")
      .then((r) => setAvailable(r.providers))
      .catch(() => setAvailable([]));
  }, []);

  return (
    <Gate>
      <h1>Sign in</h1>
      <p className="gate-lede">Use your Google or GitHub account. There's no password to remember.</p>
      {error && (
        <p className="notice error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gate-actions">
        {available?.map((p) => (
          <a key={p} className="button provider" href={`/auth/${p}/login`}>
            {providers[p]?.icon}
            Continue with {providers[p]?.name ?? p}
          </a>
        ))}
        {available?.length === 0 && <p className="notice">No sign-in option is set up. Add Google or GitHub keys to the backend's .env.</p>}
      </div>
      <p className="gate-foot">First time here? You'll choose a name and handle right after signing in.</p>
    </Gate>
  );
}
