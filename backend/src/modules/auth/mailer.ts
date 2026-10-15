import type { FastifyBaseLogger } from "fastify";
import { createTransport } from "nodemailer";

export type SendOtp = (email: string, code: string, log: FastifyBaseLogger) => Promise<void>;

// SMTP when configured; otherwise the code is written to the server log (dev only — env.ts forbids it in production).
export function createOtpSender(smtpUrl: string | undefined, from: string): SendOtp {
  if (!smtpUrl) {
    return async (email, code, log) => log.warn({ email, code }, "OTP (SMTP_URL not set, logging instead of emailing)");
  }
  const transport = createTransport(smtpUrl);
  return async (email, code) => {
    await transport.sendMail({
      from,
      to: email,
      subject: `${code} is your PaperTrade code`,
      text: `Your PaperTrade verification code is ${code}. It expires in 5 minutes. If you did not try to sign in, ignore this email.`,
    });
  };
}
