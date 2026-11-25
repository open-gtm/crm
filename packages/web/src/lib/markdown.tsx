import { Fragment, type ReactNode } from "react";
import { safeHref } from "./safe-url";

/**
 * Notes are written in Markdown and shown formatted. This renders the part of Markdown notes use
 * (headings, bold, italic, code, links, lists, quotes, code blocks) straight to React elements: no
 * HTML is ever parsed or injected, so a note can't carry markup of its own, and a link is rendered as
 * a link only when it is a plain http(s), mailto or tel address (lib/safe-url.ts). Anything it doesn't
 * know is shown as the text that was typed.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) out.push(<code key={key} className="rounded-sm bg-surface-2 px-1 font-mono text-sm">{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(t.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(t.slice(1, -1), key)}</em>);
    else {
      const link = m[4] ? /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)! : null;
      const href = safeHref(link ? link[2] : t);
      const label = link ? link[1]! : t;
      // A link that isn't a plain web, mail or phone address is shown as it was typed.
      out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">{label}</a> : t);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; text: string };

/** Splits a note into blocks. Exported for its tests. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/;
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/;
    const listOf = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null;
    if (listOf) {
      const items: string[] = [];
      for (; i < lines.length && listOf.test(lines[i]!); i++) items.push(listOf.exec(lines[i]!)![1]!);
      i--;
      blocks.push({ kind: "list", ordered: listOf === numbered, items });
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) quoted.push(lines[i]!.replace(/^>\s?/, ""));
      i--;
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|```|>|\s*[-*]\s|\s*\d{1,3}[.)]\s)/.test(lines[i]!); i++) para.push(lines[i]!);
    i--;
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

const HEADING = ["text-md font-semibold", "text-base font-semibold", "text-base font-medium text-muted"];

/** A note's text, formatted. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  const lines = (list: string[], key: string) => list.map((l, i) => <Fragment key={i}>{i ? <br /> : null}{inline(l, `${key}-${i}`)}</Fragment>);
  return (
    <div className={`flex flex-col gap-2 break-words text-base ${className ?? ""}`}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.kind === "heading") {
          const Tag = (["h3", "h4", "h5"] as const)[b.level - 1]!;
          return <Tag key={key} className={HEADING[b.level - 1]}>{inline(b.text, key)}</Tag>;
        }
        if (b.kind === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return <Tag key={key} className={`${b.ordered ? "list-decimal" : "list-disc"} pl-5`}>{b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</Tag>;
        }
        if (b.kind === "quote") return <blockquote key={key} className="border-l-2 border-line pl-3 text-muted">{lines(b.lines, key)}</blockquote>;
        if (b.kind === "code") return <pre key={key} className="overflow-x-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-sm"><code>{b.text}</code></pre>;
        return <p key={key}>{lines(b.lines, key)}</p>;
      })}
    </div>
  );
}
