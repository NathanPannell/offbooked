import { request } from "./client";
import type { JoinInfo } from "./types";

/** The whole-cast link. No auth: the token in the URL is the credential. */
export const join = {
  get: (token: string) => request<JoinInfo>(`/join/${encodeURIComponent(token)}`, { auth: { kind: "none" } }),
  claim: (token: string, input: { characterIds: string[]; firstName: string } | { listen: true }) =>
    request<{ inviteToken: string; inviteUrl: string }>(`/join/${encodeURIComponent(token)}/claim`, {
      auth: { kind: "none" },
      json: input,
    }),
};
