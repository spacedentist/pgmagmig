export function splitSql(sql: string): string[] {
  const results: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  const enum State {
    Normal,
    SingleQuote,
    DoubleQuote,
    DollarQuote,
    LineComment,
    BlockComment,
  }

  let state: State = State.Normal;
  let dollarTag = "";
  let blockDepth = 0;

  while (i < len) {
    const ch = sql[i];

    switch (state) {
      case State.Normal:
        if (ch === ";") {
          const trimmed = current.trim();
          if (trimmed) results.push(trimmed);
          current = "";
          i++;
        } else if (ch === "'") {
          current += ch;
          state = State.SingleQuote;
          i++;
        } else if (ch === '"') {
          current += ch;
          state = State.DoubleQuote;
          i++;
        } else if (ch === "-" && i + 1 < len && sql[i + 1] === "-") {
          current += "--";
          state = State.LineComment;
          i += 2;
        } else if (ch === "/" && i + 1 < len && sql[i + 1] === "*") {
          current += "/*";
          state = State.BlockComment;
          blockDepth = 1;
          i += 2;
        } else if (ch === "$") {
          const tag = matchDollarTag(sql, i);
          if (tag !== null) {
            dollarTag = tag;
            current += tag;
            state = State.DollarQuote;
            i += tag.length;
          } else {
            current += ch;
            i++;
          }
        } else {
          current += ch;
          i++;
        }
        break;

      case State.SingleQuote:
        if (ch === "'" && i + 1 < len && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (ch === "\\" && i + 1 < len) {
          current += ch + sql[i + 1];
          i += 2;
        } else if (ch === "'") {
          current += ch;
          state = State.Normal;
          i++;
        } else {
          current += ch;
          i++;
        }
        break;

      case State.DoubleQuote:
        if (ch === '"' && i + 1 < len && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (ch === '"') {
          current += ch;
          state = State.Normal;
          i++;
        } else {
          current += ch;
          i++;
        }
        break;

      case State.DollarQuote:
        if (
          ch === "$" &&
          sql.substring(i, i + dollarTag.length) === dollarTag
        ) {
          current += dollarTag;
          state = State.Normal;
          i += dollarTag.length;
        } else {
          current += ch;
          i++;
        }
        break;

      case State.LineComment:
        current += ch;
        if (ch === "\n") {
          state = State.Normal;
        }
        i++;
        break;

      case State.BlockComment:
        if (ch === "/" && i + 1 < len && sql[i + 1] === "*") {
          current += "/*";
          blockDepth++;
          i += 2;
        } else if (ch === "*" && i + 1 < len && sql[i + 1] === "/") {
          current += "*/";
          blockDepth--;
          if (blockDepth === 0) {
            state = State.Normal;
          }
          i += 2;
        } else {
          current += ch;
          i++;
        }
        break;
    }
  }

  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);

  return results;
}

function matchDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== "$") return null;

  if (pos + 1 < sql.length && sql[pos + 1] === "$") {
    return "$$";
  }

  let j = pos + 1;
  if (j >= sql.length) return null;

  const first = sql[j];
  if (!isTagStart(first)) return null;

  j++;
  while (j < sql.length && isTagContinue(sql[j])) {
    j++;
  }

  if (j < sql.length && sql[j] === "$") {
    return sql.substring(pos, j + 1);
  }

  return null;
}

function isTagStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    ch === "_" ||
    code >= 0x80
  );
}

function isTagContinue(ch: string): boolean {
  return isTagStart(ch) || (ch >= "0" && ch <= "9");
}
