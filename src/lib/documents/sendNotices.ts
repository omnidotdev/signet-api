/** A signer as returned when a draft is sent */
interface SentSigner {
  name: string;
  email: string | null;
  signToken: string;
  /** whether it is this signer's turn now (everyone, in parallel signing) */
  active: boolean;
}

/**
 * Who to email when a sender sends a draft, and whether the sender signs next.
 * A signer whose turn it is gets their link by email, except the sender
 * themself: they are already in the app, so they sign right away instead of
 * waiting on an email to their own inbox
 */
export const sendNotices = <S extends SentSigner>(
  signers: S[],
  senderEmail: string | null | undefined,
): { email: (S & { email: string })[]; senderSignsNow: boolean } => {
  const me = senderEmail?.trim().toLowerCase();
  const isSender = (s: S) =>
    Boolean(me && s.email?.trim().toLowerCase() === me);
  const active = signers.filter((s) => s.active);
  return {
    email: active.filter(
      (s): s is S & { email: string } => Boolean(s.email) && !isSender(s),
    ),
    senderSignsNow: active.some(isSender),
  };
};
