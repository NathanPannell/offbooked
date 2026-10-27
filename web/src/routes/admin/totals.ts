/** The total of one figure over a panel's rows. */
export const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((n, r) => n + pick(r), 0);
