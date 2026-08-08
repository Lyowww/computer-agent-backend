/**
 * Distinguishes one-shot user requests from multi-step goals.
 * Mirrors ai-computer-agent execution mode inference.
 */

export type ExecutionMode = 'single_action' | 'multi_step';

const MULTI_STEP_CONNECTOR =
  /\b(and then|then|after that|afterwards|followed by|next|finally)\b/i;

const ACTION_VERB =
  /\b(open|launch|start|click|double[-\s]?click|type|press|hit|go to|navigate|visit|create|write|enter|select|scroll|drag|close|quit|delete|remove|move|copy|paste|search|download|upload|login|log in|sign in|refresh|reload|focus|switch|install|save|send|submit|fill)\b/gi;

/**
 * Infer whether a user instruction is a single atomic action or a multi-step goal.
 * Defaults to single_action — never assume autonomous continuation.
 */
export function inferExecutionMode(instruction: string): ExecutionMode {
  const text = instruction.trim();
  if (!text) return 'single_action';

  if (MULTI_STEP_CONNECTOR.test(text)) {
    return 'multi_step';
  }

  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length >= 2) {
    const verbHits = sentences.filter((s) => {
      ACTION_VERB.lastIndex = 0;
      return ACTION_VERB.test(s);
    }).length;
    if (verbHits >= 2) return 'multi_step';
  }

  ACTION_VERB.lastIndex = 0;
  const verbs = text.match(ACTION_VERB) ?? [];
  if (verbs.length >= 2 && /\band\b|,/i.test(text)) {
    return 'multi_step';
  }

  const commaCount = (text.match(/,/g) ?? []).length;
  if (commaCount >= 1 && verbs.length >= 2) {
    return 'multi_step';
  }

  return 'single_action';
}
