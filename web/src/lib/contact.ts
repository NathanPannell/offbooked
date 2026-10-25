/** Where people write to us: beta access codes, privacy questions, anything else. offbooked.com receives no mail. */
export const CONTACT_EMAIL = "contact@nathanpannell.com";

export const mailto = (subject: string) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
