/** Parse a provider's access end without shifting a date-only value across time zones. */
export function parseFutureSubscriptionAccessEnd(
  value: string | undefined,
  now: Date,
): Date | null {
  if (value === undefined) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let accessEndsAt: Date;
  if (dateOnly !== null) {
    const [, year, month, day] = dateOnly;
    accessEndsAt = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59);
    if (
      accessEndsAt.getFullYear() !== Number(year) ||
      accessEndsAt.getMonth() + 1 !== Number(month) ||
      accessEndsAt.getDate() !== Number(day)
    ) {
      return null;
    }
  } else {
    accessEndsAt = new Date(value);
  }

  return Number.isNaN(accessEndsAt.getTime()) || accessEndsAt <= now ? null : accessEndsAt;
}
