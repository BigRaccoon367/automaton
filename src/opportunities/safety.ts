import type { OpportunityCandidate } from "./discovery.js";

// Conservative action indicators, not an execution permission or a full language classifier.
// Match action wording rather than every mention of accounts/payment logs in internal analysis.
const EXTERNAL_ACTION_PATTERNS = [
  /\b(?:recruit(?:s|ed|ing|ment)?|contact(?:s|ed|ing)?|outreach)\b/i,
  /\b(?:publish(?:es|ed|ing)?|publishing|posting)\b|\bpost\s+(?:a\s+|an\s+|the\s+)?(?:article|content|comment|message|ad|listing|update)\b/i,
  /\b(?:register(?:s|ed|ing)?|registration|sign[ -]?up)\b|\b(?:create|open|set\s+up)\b.{0,60}\baccounts?\b|\baccount\s+creation\b/i,
  /\b(?:purchas(?:e|es|ed|ing)|buy(?:s|ing)?|spend(?:s|ing)?|pay(?:s|ing)?)\b|\b(?:make|process|execute|initiate|send|perform|accept|collect|receive)\b.{0,60}\b(?:payments?|transactions?|transfers?)\b|\b(?:payment|transaction)\s+(?:processing|execution)\b/i,
  /\bsubmit(?:s|ted|ting)?\b|\b(?:apply|applying|applies|applied)\s+(?:for|to)\b/i,
  /\b(?:send|sending|sent)\b.{0,60}\b(?:e[ -]?mails?|dms?|direct\s+messages?|messages?)\b|\b(?:email(?:s|ed|ing)?|dm(?:s|ed|ing)?|messag(?:e|es|ed|ing))\b.{0,60}\b(?:testers?|users?|clients?|customers?|people|firms?|them)\b/i,
  /\b(?:upload|delete|modify|update)\b.{0,60}\b(?:external|remote|service|account|profile)\b|\b(?:external|remote)\b.{0,60}\b(?:upload|delete|modify|update)\b/i,
];

// Engagement can be implied across title, description and evidence, without an
// explicit "contact" verb. Favor approval when both concepts occur anywhere in the candidate.
const EXTERNAL_PARTY_PATTERN = /\b(?:testers?|users?|clients?|customers?|compan(?:y|ies)|firms?|business(?:es)?|people|persons?)\b/i;
const ENGAGEMENT_PATTERNS = [
  /\b(?:offer(?:s|ed|ing)?|invit(?:e|es|ed|ing|ations?)|onboard(?:s|ed|ing)?|recruit(?:s|ed|ing|ment)?|contact(?:s|ed|ing)?|messag(?:e|es|ed|ing))\b|\breach(?:es|ed|ing)?\s+out\b/i,
  /\b(?:provid(?:e|es|ed|ing)|giv(?:e|es|ing)|gave|grant(?:s|ed|ing)?)\b.{0,80}\baccess\b/i,
  /\b(?:run(?:s|ning)?|ran|launch(?:es|ed|ing)?)\b.{0,80}\b(?:pilots?|(?:tester|testing|beta)\s+programs?)\b/i,
  /\b(?:request(?:s|ed|ing)?|collect(?:s|ed|ing)?)\b.{0,80}\bfeedback\b/i,
];

export function requiresExternalAction(
  candidate: Pick<OpportunityCandidate, "title" | "description" | "evidence" | "requiresExternalAction">,
): boolean {
  // Monotonic escalation: a model-provided true can never be downgraded.
  if (candidate.requiresExternalAction) return true;
  const texts = [candidate.title, candidate.description, ...candidate.evidence]
    .map((text) => text.replace(/\s+/g, " "));
  const combined = texts.join(" ");
  return texts.some((text) => EXTERNAL_ACTION_PATTERNS.some((pattern) => pattern.test(text))) ||
    (ENGAGEMENT_PATTERNS.some((pattern) => pattern.test(combined)) && EXTERNAL_PARTY_PATTERN.test(combined));
}
