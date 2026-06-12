/**
 * Composer arrow-key history navigation for the WC shell.
 *
 * ArrowUp at the start of the composer walks backwards through the user's
 * messages in the thread (most recent first), scrolling each into view.
 * ArrowDown walks forward again; stepping past the most recent user message
 * returns focus to the composer with the caret at the end of the input.
 *
 * The walk index resets whenever the user interacts with the thread
 * (pointerdown) or types into the composer, so the next ArrowUp starts
 * from the most recent user message again.
 */

interface HistoryNavThread extends HTMLElement {
  scrollToBottom?: () => void;
}

interface HistoryNavInputCard extends HTMLElement {
  focusEnd?: () => void;
}

export function wireWcHistoryNav(opts: {
  thread: HistoryNavThread;
  inputCard: HistoryNavInputCard;
}): void {
  const { thread, inputCard } = opts;
  let index: number | null = null;

  const userMessages = (): HTMLElement[] =>
    Array.from(thread.querySelectorAll<HTMLElement>('slicc-user-message'));

  // Comfortably past slicc-chat-thread's FOLLOW_SLACK (80px).
  const FOLLOW_ESCAPE = 200;

  const scrollToIndex = (messages: HTMLElement[], i: number): void => {
    const target = messages[i];
    if (!target) return;
    // Hop out of the follow zone instantly before the smooth glide: a glide
    // starting at the bottom is still "near the bottom" when a live append's
    // requestFollow() samples the position mid-flight, and the resulting
    // scrollToBottom cancels the walk. The hop is a few px and imperceptible.
    const fromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    if (fromBottom < FOLLOW_ESCAPE) thread.scrollTop -= FOLLOW_ESCAPE - fromBottom;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const reset = (): void => {
    index = null;
  };

  inputCard.addEventListener('history-up', () => {
    const messages = userMessages();
    if (messages.length === 0) return;
    index = index === null ? messages.length - 1 : Math.max(0, index - 1);
    scrollToIndex(messages, index);
  });

  inputCard.addEventListener('history-down', () => {
    if (index === null) return;
    const messages = userMessages();
    if (messages.length === 0) {
      index = null;
      return;
    }
    if (index >= messages.length - 1) {
      index = null;
      if (thread.scrollToBottom) thread.scrollToBottom();
      else thread.scrollTop = thread.scrollHeight;
      inputCard.focusEnd?.();
      return;
    }
    index += 1;
    scrollToIndex(messages, index);
  });

  thread.addEventListener('pointerdown', reset);
  inputCard.addEventListener('input', reset);
}
