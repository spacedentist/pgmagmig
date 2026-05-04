import pg from "pg";

export const escapeLiteral: (str: string) => string = pg.escapeLiteral;
export const escapeIdentifier: (str: string) => string = pg.escapeIdentifier;
