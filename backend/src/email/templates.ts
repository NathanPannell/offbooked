import type { Email } from "./mailer.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Message {
  subject: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  footer?: string;
  footerLink?: { label: string; url: string };
}

function render(to: string, m: Message, headers?: Record<string, string>): Email {
  const button = m.button
    ? `<p style="margin:28px 0"><a href="${esc(m.button.url)}" style="background:#1f1a17;color:#fff8ef;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">${esc(m.button.label)}</a></p>`
    : "";
  const footerLink = m.footerLink ? ` <a href="${esc(m.footerLink.url)}" style="color:#8a7f74">${esc(m.footerLink.label)}</a>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1a17">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fffdf9;border-radius:16px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#a0522d;font-weight:700">Offbooked</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${esc(m.heading)}</h1>
${m.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${esc(p)}</p>`).join("\n")}
${button}
${m.footer || footerLink ? `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#8a7f74">${esc(m.footer ?? "")}${footerLink}</p>` : ""}
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    m.heading,
    "",
    ...m.paragraphs,
    ...(m.button ? ["", `${m.button.label}: ${m.button.url}`] : []),
    ...(m.footer ? ["", m.footer] : []),
    ...(m.footerLink ? [`${m.footerLink.label}: ${m.footerLink.url}`] : []),
  ].join("\n");
  return { to, subject: m.subject, html, text, headers };
}

export function signInEmail(to: string, link: string): Email {
  return render(to, {
    subject: "Your Offbooked sign-in link",
    heading: "Sign in to Offbooked",
    paragraphs: ["Tap the button to sign in. The link works once and expires in 15 minutes."],
    button: { label: "Sign in", url: link },
    footer: "If you didn't ask for this, you can ignore this email.",
  });
}

export function actorDoneEmail(to: string, p: { actorName: string; lines: number; title: string; url: string }): Email {
  return render(to, {
    subject: `${p.actorName} finished all ${p.lines} lines`,
    heading: `${p.actorName} finished all ${p.lines} lines`,
    paragraphs: [`Every line for ${p.actorName} in ${p.title} is recorded.`],
    button: { label: "See progress", url: p.url },
  });
}

export function castCompleteEmail(to: string, p: { title: string; url: string }): Email {
  return render(to, {
    subject: "Cast complete — ready to listen through",
    heading: "Cast complete — ready to listen through",
    paragraphs: [`Every cast line in ${p.title} is recorded, and the whole play is ready to listen through.`],
    button: { label: "Listen through the play", url: p.url },
  });
}

export function runthroughReadyEmail(to: string, p: { title: string; directorName: string; url: string; unsubscribeUrl: string }): Email {
  return render(
    to,
    {
      subject: `${p.title} is ready to listen through`,
      heading: `${p.title} is ready to listen through`,
      paragraphs: [`Everyone has recorded their lines. Listen to the whole show and follow along with your part.`],
      button: { label: "Listen through the play", url: p.url },
      footer: `You're getting this one email because ${p.directorName} cast you in ${p.title} on Offbooked.`,
      footerLink: { label: "Unsubscribe", url: p.unsubscribeUrl },
    },
    { "List-Unsubscribe": `<${p.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  );
}
