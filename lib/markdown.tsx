import { Fragment, type ReactNode } from "react";

// GM narration markdown. The model is only instructed to emit **bold**,
// *italics*, and "> " read-aloud lines (convex/gm/prompt.ts), so this parses
// exactly that — no links, headings, lists, or code. Everything is rendered
// as React text nodes; no HTML is ever injected.

type InlineSegment = { text: string; bold: boolean; italic: boolean };

type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "bold" }
  | { kind: "italic" };

// A run of n asterisks decomposes into floor(n/2) bold toggles plus (n % 2)
// italic toggles, so "***" opens (or closes) bold and italic together.
function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "*") {
      let j = i;
      while (j < text.length && text[j] === "*") j++;
      const run = j - i;
      for (let k = 0; k < Math.floor(run / 2); k++) tokens.push({ kind: "bold" });
      if (run % 2 === 1) tokens.push({ kind: "italic" });
      i = j;
    } else {
      let j = text.indexOf("*", i);
      if (j === -1) j = text.length;
      tokens.push({ kind: "text", value: text.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

// Flat styled segments rather than a tree, so overlapping markers can never
// produce broken nesting.
function parseInline(text: string): InlineSegment[] {
  const tokens = tokenizeInline(text);
  // An odd marker count means the LAST occurrence never closes — render it
  // as the literal characters instead of leaving a style dangling.
  const lastUnclosed = { bold: -1, italic: -1 };
  for (const kind of ["bold", "italic"] as const) {
    const indices = tokens.flatMap((t, idx) => (t.kind === kind ? [idx] : []));
    if (indices.length % 2 === 1) lastUnclosed[kind] = indices[indices.length - 1];
  }
  const segments: InlineSegment[] = [];
  let bold = false;
  let italic = false;
  const push = (value: string) => {
    const prev = segments[segments.length - 1];
    if (prev && prev.bold === bold && prev.italic === italic) prev.text += value;
    else segments.push({ text: value, bold, italic });
  };
  tokens.forEach((token, idx) => {
    if (token.kind === "text") push(token.value);
    else if (idx === lastUnclosed[token.kind]) push(token.kind === "bold" ? "**" : "*");
    else if (token.kind === "bold") bold = !bold;
    else italic = !italic;
  });
  return segments;
}

// One alternation for every known name: longest-first so "Pulau Bisikan"
// beats "Pulau", metachars escaped, custom boundaries instead of \b (which
// breaks on non-ASCII letters) so possessives and punctuation still match
// ("Rahim's", "Kora,"). Case-sensitive on purpose — proper nouns only.
function buildNameRegex(names: string[]): RegExp | undefined {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (cleaned.length === 0) return undefined;
  cleaned.sort((a, b) => b.length - a.length);
  const alternation = cleaned
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Leading boundary is a capture group, not a lookbehind — lookbehind throws
  // at construction on Safari < 16.4 and would crash the whole game screen.
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(${alternation})(?=$|[^\\p{L}\\p{N}])`,
    "gu",
  );
}

// Wrap name matches in the same <strong> the model's own **bold** produces.
// Only plain text reaches here — already-bold segments are never re-wrapped.
function highlightNames(text: string, regex: RegExp): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const nameStart = match.index + match[1].length;
    if (nameStart > last) nodes.push(text.slice(last, nameStart));
    nodes.push(<strong key={nameStart}>{match[2]}</strong>);
    last = nameStart + match[2].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Inline-only markdown (**bold**/*italics*) for short, already-styled strings —
// e.g. Codex location/quest/faction blurbs and POI descriptions, which the GM
// writes with markers but which render inside their own <p> tags. Emits inline
// nodes (no block <p>/<blockquote> wrappers) so they nest in the caller's element.
export function renderInlineMarkdown(text: string): ReactNode[] {
  return renderInline(text);
}

function renderInline(text: string, highlight?: RegExp): ReactNode[] {
  return parseInline(text).map((seg, i) => {
    if (seg.bold && seg.italic)
      return (
        <strong key={i}>
          <em>{seg.text}</em>
        </strong>
      );
    if (seg.bold) return <strong key={i}>{seg.text}</strong>;
    if (seg.italic)
      return <em key={i}>{highlight ? highlightNames(seg.text, highlight) : seg.text}</em>;
    if (highlight) return <Fragment key={i}>{highlightNames(seg.text, highlight)}</Fragment>;
    return seg.text;
  });
}

// Full parse for settled messages: consecutive "> " lines become one
// <blockquote>, other non-blank runs become <p>. Blank lines only separate
// blocks — spacing comes from the .gm-prose styles in globals.css. Known
// names (party, location, anything the GM has ever bolded) are re-bolded
// wherever the model forgot the markers.
export function renderGmMarkdown(content: string, knownNames?: string[]): ReactNode {
  const highlight = knownNames ? buildNameRegex(knownNames) : undefined;
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^> ?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={blocks.length}>
          {renderInline(quote.join("\n"), highlight)}
        </blockquote>,
      );
    } else if (lines[i].trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith(">")) {
        para.push(lines[i]);
        i++;
      }
      blocks.push(<p key={blocks.length}>{renderInline(para.join("\n"), highlight)}</p>);
    }
  }
  return blocks;
}

export type StreamToken = { text: string; bold: boolean; italic: boolean; quote: boolean };

// Incremental formatter for the streaming path. Chunks arrive at arbitrary
// boundaries — a marker can be split across feeds — so a trailing run of "*"
// (or a ">" right after a newline, whose following space also belongs to the
// marker) is held pending until the next chunk decides its meaning. Tokens
// split on whitespace boundaries and whenever the style flags change, so the
// caller can animate them word by word.
export function createStreamingMarkdown() {
  let bold = false;
  let italic = false;
  let quote = false;
  let atLineStart = true;
  let pending = "";

  function feed(chunk: string): StreamToken[] {
    const text = pending + chunk;
    pending = "";
    const tokens: StreamToken[] = [];
    let buf = "";
    let bufIsSpace = false;
    let bufFlags = { bold, italic, quote };
    const flushBuf = () => {
      if (buf) tokens.push({ text: buf, ...bufFlags });
      buf = "";
    };
    const append = (ch: string, isSpace: boolean) => {
      if (buf && bufIsSpace !== isSpace) flushBuf();
      if (!buf) {
        bufFlags = { bold, italic, quote };
        bufIsSpace = isSpace;
      }
      buf += ch;
    };

    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "*") {
        let j = i;
        while (j < text.length && text[j] === "*") j++;
        if (j === text.length) {
          // the run may continue into the next chunk — defer judgement
          pending = text.slice(i);
          break;
        }
        flushBuf();
        const run = j - i;
        if (Math.floor(run / 2) % 2 === 1) bold = !bold;
        if (run % 2 === 1) italic = !italic;
        atLineStart = false;
        i = j;
      } else if (ch === ">" && atLineStart) {
        if (i === text.length - 1) {
          pending = ">";
          break;
        }
        flushBuf();
        quote = true;
        atLineStart = false;
        i += text[i + 1] === " " ? 2 : 1;
      } else if (/\s/.test(ch)) {
        append(ch, true);
        if (ch === "\n") {
          atLineStart = true;
          quote = false;
        }
        i++;
      } else {
        append(ch, false);
        atLineStart = false;
        i++;
      }
    }
    flushBuf();
    return tokens;
  }

  // Any text still awaiting more input, as literal characters. Unused today —
  // the settled path re-renders the full parse — but exposed for correctness.
  function flush(): string {
    const rest = pending;
    pending = "";
    return rest;
  }

  return { feed, flush };
}
