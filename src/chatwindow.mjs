// Which records a chat opens with (1.5.68).
//
// It used to be the last `limit` records of any kind. A long task filled them all with steps: after
// 「可以排」 TikTok运营 took 316 steps on YouTube Studio, the last 200 records were all tool rows, the
// chat hides those, and the page showed only the greeting - the human thought the chat was gone.
// Now `limit` counts lines of the conversation (what the human and the bot said, cards, turn marks),
// and the steps between them come along. Steps are capped separately, newest first, at the 200 records the
// window held before (a real chat with steps shown stays about 0.5 MB); a step the chat draws (a card, the step right after a card
// you answered, 「改了 N 个文件 · 撤销」) is never dropped.

export const CHAT_WINDOW_STEPS = 200;

const isToolRow = (r) => r?.kind === 'tool';

/**
 * records: the chat's records, oldest first. limit: how many lines of the conversation.
 * isStep(r): a step, not a line (default: kind 'tool').
 * keepStep(r, prev): a step the chat draws, kept even past the step cap.
 */
export function chatWindow(records, limit, { isStep = isToolRow, keepStep = () => false, maxSteps = CHAT_WINDOW_STEPS } = {}) {
  const list = Array.isArray(records) ? records : [];
  const want = Math.max(1, Number(limit) || 0);
  let lines = 0;
  let start = list.length;
  while (start > 0 && lines < want) {
    start -= 1;
    if (!isStep(list[start])) lines += 1;
  }
  const window = list.slice(start);
  let steps = 0;
  const keep = new Array(window.length);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const r = window[i];
    if (!isStep(r)) { keep[i] = true; continue; }
    steps += 1;
    keep[i] = steps <= maxSteps || keepStep(r, window[i - 1]);
  }
  return window.filter((_, i) => keep[i]);
}
