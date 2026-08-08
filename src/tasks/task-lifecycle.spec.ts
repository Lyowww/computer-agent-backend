import {
  inferExecutionMode,
} from './execution-mode';
import {
  decideAfterActionBatch,
  looksLikeFakeUserApproval,
  shouldReplanOnNonExecutablePlan,
} from './task-lifecycle';

describe('inferExecutionMode', () => {
  it('Click refresh → single_action', () => {
    expect(inferExecutionMode('Click refresh')).toBe('single_action');
  });

  it('Open Chrome → single_action', () => {
    expect(inferExecutionMode('Open Chrome')).toBe('single_action');
  });

  it('Click the Settings button → single_action', () => {
    expect(inferExecutionMode('Click the Settings button')).toBe(
      'single_action',
    );
  });

  it('Open Chrome and go to youtube.com → multi_step', () => {
    expect(inferExecutionMode('Open Chrome and go to youtube.com')).toBe(
      'multi_step',
    );
  });

  it('Open VS Code, create a file, and type hello → multi_step', () => {
    expect(
      inferExecutionMode('Open VS Code, create a file, and type hello'),
    ).toBe('multi_step');
  });
});

describe('decideAfterActionBatch', () => {
  it('Test 1: single_action success → complete (no replan)', () => {
    expect(
      decideAfterActionBatch({
        mode: 'single_action',
        allSucceeded: true,
        isTerminal: false,
      }),
    ).toEqual({
      kind: 'complete',
      summary: 'Action completed successfully',
    });
  });

  it('Test 2: Open Chrome single_action → complete after success', () => {
    const mode = inferExecutionMode('Open Chrome');
    expect(mode).toBe('single_action');
    expect(
      decideAfterActionBatch({
        mode,
        allSucceeded: true,
        isTerminal: false,
      }).kind,
    ).toBe('complete');
  });

  it('Test 3: multi_step success → replan until COMPLETED', () => {
    expect(
      decideAfterActionBatch({
        mode: 'multi_step',
        allSucceeded: true,
        isTerminal: false,
      }).kind,
    ).toBe('replan');
  });

  it('Test 4: NEEDS_USER_INPUT / fake approval detection', () => {
    expect(
      looksLikeFakeUserApproval({
        message: "Clicking 'Approve'...",
        actions: [{ type: 'CLICK', params: { x: 1, y: 2 } }],
      }),
    ).toBe(true);
    expect(
      looksLikeFakeUserApproval({
        message: 'Clicking the refresh button',
        actions: [{ type: 'CLICK', params: { x: 1, y: 2 } }],
      }),
    ).toBe(false);
  });

  it('Test 5: terminal task → noop (0 further AI / screenshots)', () => {
    expect(
      decideAfterActionBatch({
        mode: 'multi_step',
        allSucceeded: true,
        isTerminal: true,
      }).kind,
    ).toBe('noop');
  });

  it('Test 6: single_action never replans on SCREENSHOT-only plans', () => {
    expect(
      shouldReplanOnNonExecutablePlan({
        mode: 'single_action',
        wireStatus: 'continue',
        hasDone: false,
      }),
    ).toBe(false);
  });

  it('single_action failure → fail (not replan)', () => {
    expect(
      decideAfterActionBatch({
        mode: 'single_action',
        allSucceeded: false,
        lastError: 'missed click',
        isTerminal: false,
      }),
    ).toEqual({ kind: 'fail', error: 'missed click' });
  });
});
