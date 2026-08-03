const HEALTHY_START = "<!-- janusly:healthy-benchmark:start -->";
const HEALTHY_END = "<!-- janusly:healthy-benchmark:end -->";
const HOSTILE_START = "<!-- janusly:hostile-benchmark:start -->";
const HOSTILE_END = "<!-- janusly:hostile-benchmark:end -->";

function generatedBlock(startMarker, endMarker, content) {
  return `${startMarker}\n${content.trim()}\n${endMarker}`;
}

function replaceMarkedSection(document, startMarker, endMarker, content) {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker);
  if ((start === -1) !== (end === -1)) {
    throw new Error(`malformed generated benchmark section: ${startMarker}`);
  }
  if (start === -1) return null;
  if (end < start) {
    throw new Error(`reversed generated benchmark section: ${startMarker}`);
  }
  const after = end + endMarker.length;
  return document.slice(0, start)
    + generatedBlock(startMarker, endMarker, content)
    + document.slice(after);
}

export function replaceHealthyReport(document, content) {
  const marked = replaceMarkedSection(document, HEALTHY_START, HEALTHY_END, content);
  if (marked !== null) return `${marked.trimEnd()}\n`;

  // Migrate the historical unmarked document without consuming its reviewed
  // allocation and hostile-world appendices. The healthy report owns only the
  // leading H1 section; every H2 and later remains independent evidence.
  const appendix = document.search(/\n## /);
  const suffix = appendix === -1 ? "" : document.slice(appendix).trim();
  const block = generatedBlock(HEALTHY_START, HEALTHY_END, content);
  return suffix === "" ? `${block}\n` : `${block}\n\n${suffix}\n`;
}

export function replaceHostileReport(document, content) {
  const marked = replaceMarkedSection(document, HOSTILE_START, HOSTILE_END, content);
  if (marked !== null) return `${marked.trimEnd()}\n`;

  // Older reports appended one hostile section at EOF. Replace that latest
  // summary while the JSONL series retains the complete measurement history.
  const legacy = document.search(/\n## Escenario hostil(?: \([^\n]*\))? —/);
  const prefix = (legacy === -1 ? document : document.slice(0, legacy)).trimEnd();
  const block = generatedBlock(HOSTILE_START, HOSTILE_END, content);
  return prefix === "" ? `${block}\n` : `${prefix}\n\n${block}\n`;
}
