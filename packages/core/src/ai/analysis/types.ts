/**
 * The shape one analysed call comes back as.
 *
 * A model is asked for this and is not trusted to produce it: every field is
 * clamped and defaulted on the way in, so a provider that answers with a
 * three-sentence essay, a sentiment of `VERY_POSITIVE`, or a score of 900 still
 * yields a record the rest of the system can rely on.
 */

/** The prospect's mood. Deliberately not the agent's. */
export type AiSentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED";

/** Per-dimension quality, 1-5 each. */
export interface CallQualityScores {
  /** How likely this is to convert. */
  conversion: number;
  /** The agent's politeness and rapport. */
  politeness: number;
  /** How effectively the agent questioned. */
  questioning: number;
  /** How engaged the prospect was. */
  engagement: number;
  /** The prospect's sentiment, 1-5. */
  sentiment: number;
}

export interface CallAnalysis {
  /** One or two sentences, what happened on the call. */
  summary: string;
  sentiment: AiSentiment;
  /** 0-100: how well the call went for the prospect. */
  score: number;
  scores: CallQualityScores;
  /** At most five short points. */
  keyPoints: string[];
  /** 0-1: the model's own confidence, not a calibrated probability. */
  confidence: number;
  /** The model that produced this, recorded so a rating can be traced. */
  model: string;
}
