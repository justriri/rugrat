// The words the UI uses for a run's onchain status. The stored status values (ONCHAIN_VERIFIED, ...)
// are an internal, persisted format and are NOT renamed; only what the player reads is.
//
// "Recorded onchain" is deliberately modest: the record was signed by the wallet, exists onchain,
// is well-formed and is consistent with the game's replay, verdict and score rules. It does not
// prove the replay was physically played.
import type { RunBadge } from './chainState';

export const CHAIN_BADGE_LABEL: Record<RunBadge, string> = {
  LOCAL: 'LOCAL',
  SUBMITTED: 'SUBMITTED',
  ONCHAIN_VERIFIED: 'RECORDED ONCHAIN',
};

export const RECORDED_EXPLAINER = "A signed record checked against the game's rules. It does not prove the run was played.";
