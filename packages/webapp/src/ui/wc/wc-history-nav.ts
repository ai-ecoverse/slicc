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

  const FOLLOW_ESCAPE = 200;

  const scrollToIndex = (messages: HTMLElement[], i: number): void => {
    const target = messages[i];
    if (!target) return;

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
