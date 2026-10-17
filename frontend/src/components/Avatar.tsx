import type { Me } from "../api.js";

// The provider's photo when there is one, else initials. Google photos need no-referrer to load.
export function Avatar({ me, size = 32 }: { me: Me; size?: number }) {
  const initials = me.displayName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return me.avatarUrl ? (
    <img className="avatar" src={me.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {initials}
    </span>
  );
}
