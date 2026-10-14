/**
 * A document-shaped service answer of a chosen size: a root with hundreds of rows, each carrying a
 * paragraph of text, a few fields, tags and a child list — the shape of a large editor document a
 * service returns whole on every open. `documentBody(bytes)` sizes the rows so the compact JSON of
 * the value is at least `bytes` long (the size a serialization suite measures against).
 */
export type DocumentRow = {
  id: string;
  index: number;
  parent: string | null;
  type: string;
  text: string;
  tags: string[];
  children: string[];
  depth: number;
  done: boolean;
  updatedAt: number;
};

export type DocumentBody = {
  id: string;
  title: string;
  version: number;
  rows: DocumentRow[];
  catalogs: { types: { id: string; name: string; fields: string[] }[] };
};

const PARAGRAPH =
  'The quick brown fox jumps over the lazy dog, then writes a note about it: “naïve”, résumé, ' +
  'Ångström, a check ✓ and a globe 🌍 — with a "double quote", a backslash \\ and a\nline break. ';

export function documentBody(bytes: number): DocumentBody {
  const rows: DocumentRow[] = [];
  const body: DocumentBody = {
    id: 'document-root',
    title: 'A large document',
    version: 7,
    rows,
    catalogs: {
      types: Array.from({ length: 24 }, (_, i) => ({
        id: `type-${i}`,
        name: `Type ${i}`,
        fields: ['title', 'text', 'tags', 'done'],
      })),
    },
  };
  let size = JSON.stringify(body).length;
  for (let i = 0; size < bytes; i++) {
    const row: DocumentRow = {
      id: `row-${i}`,
      index: i,
      parent: i === 0 ? null : `row-${Math.floor((i - 1) / 3)}`,
      type: `type-${i % 24}`,
      text: PARAGRAPH.repeat(1 + (i % 7)),
      tags: ['alpha', 'beta', `tag-${i % 11}`],
      children: [`row-${3 * i + 1}`, `row-${3 * i + 2}`, `row-${3 * i + 3}`],
      depth: Math.floor(Math.log(2 * i + 1) / Math.log(3)),
      done: i % 2 === 0,
      updatedAt: 1_700_000_000_000 + i * 1000,
    };
    rows.push(row);
    size += JSON.stringify(row).length + 1;
  }
  return body;
}
