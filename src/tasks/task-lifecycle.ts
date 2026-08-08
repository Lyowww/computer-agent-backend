import type { ExecutionMode } from './execution-mode';

export type AfterActionsDecision =
  | { kind: 'complete'; summary: string }
  | { kind: 'fail'; error: string }
  | { kind: 'replan' }
  | { kind: 'noop' };

/**
 * After planned actions finish executing, decide whether the task is done
 * or whether another AI planning cycle is allowed.
 */
export function decideAfterActionBatch(input: {
  mode: ExecutionMode;
  allSucceeded: boolean;
  lastError?: string;
  isTerminal: boolean;
}): AfterActionsDecision {
  if (input.isTerminal) {
    return { kind: 'noop' };
  }

  if (input.mode === 'single_action') {
    if (input.allSucceeded) {
      return {
        kind: 'complete',
        summary: 'Action completed successfully',
      };
    }
    return {
      kind: 'fail',
      error: input.lastError ?? 'Action failed',
    };
  }

  // multi_step: continue planning until the model returns COMPLETED
  return { kind: 'replan' };
}

/**
 * Whether SCREENSHOT / WAIT-only plans may trigger another capture+plan cycle.
 * Single-action tasks must never enter a screenshot→AI→screenshot loop.
 */
export function shouldReplanOnNonExecutablePlan(input: {
  mode: ExecutionMode;
  wireStatus: string;
  hasDone: boolean;
}): boolean {
  if (input.wireStatus === 'completed' || input.hasDone) return false;
  if (input.wireStatus === 'failed') return false;
  if (input.wireStatus === 'need_user') return false;
  if (input.mode === 'single_action') return false;
  return true;
}

const FAKE_APPROVAL_TEXT =
  /\b(click(?:ing)?\s+['"]?(approve|ai)['"]?|acknowledg(?:e|ing)\s+user\s+approval|approving\s+(?:the\s+)?(?:potential\s+)?action|typing\s+the\s+user'?s?\s+instruction|waiting\s+for\s+further\s+instructions|continue\s+the\s+task\s+as\s+approved)\b/i;

export function looksLikeFakeUserApproval(input: {
  message?: string;
  actions: Array<{ type: string; params: Record<string, unknown> }>;
}): boolean {
  if (input.message && FAKE_APPROVAL_TEXT.test(input.message)) {
    return true;
  }
  for (const action of input.actions) {
    if (action.type === 'TYPE_TEXT') {
      const typed = String(action.params.text ?? '').toLowerCase();
      if (
        typed.startsWith('approved:') ||
        /^approve\b/.test(typed)
      ) {
        return true;
      }
    }
  }
  return false;
}
