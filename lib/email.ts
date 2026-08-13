/** Outbound email.
 *
 * Uses Resend when RESEND_API_KEY is set; otherwise logs the message to the
 * server console so local development works with no third-party account.
 */

const FROM = process.env.EMAIL_FROM ?? "Terrain <onboarding@resend.dev>";

type Mail = { to: string; subject: string; html: string; text: string };

async function send(mail: Mail): Promise<{ delivered: boolean; preview?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `\n─── EMAIL (dev, not sent) ───\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n─────────────────────────────\n`,
    );
    return { delivered: false, preview: mail.text };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
  return { delivered: true };
}

export async function sendMagicLink(to: string, url: string) {
  return send({
    to,
    subject: "Your Terrain sign-in link",
    text: `Sign in to Terrain:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once.\nIf you didn't request it, you can ignore this email.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f2b2a">
        <p style="font-size:22px;margin:0 0 24px">Sign in to <strong>Terrain</strong></p>
        <p style="color:#4a5f5e;line-height:1.6;margin:0 0 28px">
          Click below to access your feed of newly discovered stores.
        </p>
        <a href="${url}"
           style="display:inline-block;background:#e8622c;color:#faf6ec;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600">
          Open Terrain
        </a>
        <p style="color:#8a9a99;font-size:13px;line-height:1.6;margin:28px 0 0">
          This link expires in 15 minutes and can only be used once.<br>
          If you didn't request it, you can safely ignore this email.
        </p>
      </div>`,
  });
}
