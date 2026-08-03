/**
 * Closed regex for sensitive object-key names.
 *
 * Lives in `src/lib` (the layer with no runtime deps and no DB
 * access) so both the persistence chokepoint (`safe-persist.ts`) and the
 * pure structural diff (`workflow-diff.ts`) can match against the same
 * source of truth without forcing one layer to depend on the other.
 *
 * Adding a new key shape here improves redaction at write time AND the
 * UI's secret-ref tagging at diff time. Don't widen patterns without
 * weighing false positives — the regex matches WHOLE keys plus common
 * separator/camel-case suffixes.
 */
export const SENSITIVE_KEY_PATTERN =
  /^(?:[sS][eE][cC][rR][eE][tT](?:$|[_-].*|[A-Z].*)|[pP][aA][sS][sS][wW][oO][rR][dD](?:$|[_-].*|[A-Z].*)|[tT][oO][kK][eE][nN](?:$|[_-].*|[A-Z].*)|[aA][pP][iI][_-]?[kK][eE][yY]|[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|[cC][oO][oO][kK][iI][eE]|[xX]-[aA][pP][iI]-[kK][eE][yY]|[cC][lL][iI][eE][nN][tT][_-]?[sS][eE][cC][rR][eE][tT]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY])$/;
