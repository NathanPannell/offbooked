/** Where people write to us: questions about the beta, privacy, anything else. offbooked.com receives no mail. */
export const CONTACT_EMAIL = "contact@nathanpannell.com";

export const mailto = (subject: string) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
