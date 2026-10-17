import { Gate } from "../components/Gate.js";
import { linkProps } from "../nav.js";

// Where sign-out lands: confirms it worked and offers the way back, instead of dropping the player on the sign-in form.
export function SignedOut() {
  return (
    <Gate>
      <h1>You're signed out</h1>
      <p className="gate-lede">Your cash, shares and open orders are saved. Limit orders keep working while you're away.</p>
      <div className="gate-actions">
        <a className="button primary" {...linkProps("/login")}>
          Sign in again
        </a>
      </div>
    </Gate>
  );
}
