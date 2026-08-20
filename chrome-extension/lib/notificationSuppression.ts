/**
 * The visible content of one notification — everything the user actually reads.
 * Two notifications with the same title and body are the same notification as
 * far as anyone looking at the screen is concerned, whichever code path built
 * them.
 */
export interface ShownNotification {
  title: string;
  body: string;
}

/**
 * Whether a notification would repeat the last one shown, and so should be
 * dropped.
 *
 * Every notification here is a statement about the current state ("you've used
 * 95% of this window's limit", "recommended model: Sonnet"), not a record of an
 * event. Saying it a second time adds nothing, and a duplicate banner reads as a
 * bug rather than as news. Only the immediately preceding notification is
 * compared: a message that becomes true again after something else was said in
 * between is worth repeating.
 */
export function isRepeatOfLastNotification(
  lastShown: ShownNotification | null,
  candidate: ShownNotification,
): boolean {
  return (
    lastShown !== null && lastShown.title === candidate.title && lastShown.body === candidate.body
  );
}
