import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { navigate, usePath } from "./nav.js";
import { Login } from "./pages/Login.js";
import { Profile } from "./pages/Profile.js";
import { SignedOut } from "./pages/SignedOut.js";
import { Trade } from "./pages/Trade.js";
import "./styles.css";

const PUBLIC = ["/login", "/signed-out"];

// Who is signed in is asked once (/me) and kept, so moving between pages is instant: no blank screen, no re-check.
// No session -> /login. Profile not finished -> /profile, and the app stays closed until it is.
function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still asking

  useEffect(() => {
    if (PUBLIC.includes(path)) return setMe(undefined); // signed out: ask again after the next sign-in
    if (me !== undefined) return;
    api<Me>("GET", "/me").then(setMe, () => setMe(null));
  }, [path, me]);

  useEffect(() => {
    if (PUBLIC.includes(path) || me === undefined) return;
    if (me === null) navigate("/login", true);
    else if (!me.profileComplete && path !== "/profile") navigate("/profile", true);
  }, [path, me]);

  if (path === "/login") return <Login />;
  if (path === "/signed-out") return <SignedOut />;
  if (!me) return null; // the first check takes a moment; render nothing rather than a placeholder that flashes
  if (path === "/profile") return <Profile me={me} onSaved={setMe} />;
  if (!me.profileComplete) return null;
  return <Trade me={me} path={path} onProfileSaved={setMe} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
