const englishStopWords = new Set('a an and are as at be by can could do does for from how i in is it me my of on or please should tell that the their this to use using was what when where which who why will with would you your save note notes summarize summary'.split(' '));
const chineseFillers = /请问|请帮我|帮我|告诉我|什么是|是什么|为什么|怎么样|怎么|如何|一下|相关|有关|是否|可以|需要|应该|进行|总结|整理|保存|笔记|生成|回答|知识库|依据|根据|并且|以及|然后|这些|这个|一个/g;

// Keep repeated tokens internally for BM25 term frequency; the public tokenizer
// returns distinct query terms as before. Chinese uses character bigrams.
function terms(text) {
  const cleaned = String(text).normalize('NFKC').toLowerCase().replace(chineseFillers, ' ');
  const tokens = (cleaned.match(/[a-z][a-z0-9_-]+/g) || []).filter(token => !englishStopWords.has(token));
  for (const phrase of cleaned.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < phrase.length - 1; i++) tokens.push(phrase.slice(i, i + 2));
  }
  return tokens;
}
export function tokenize(text) { return [...new Set(terms(text))]; }

/** Bounded overlapping windows preserve the document location of each result.
 * Offsets are UTF-16 code-unit offsets, matching JavaScript's String.slice(). */
export function chunkDocument(document, { size = 600, overlap = 120 } = {}) {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) || size < 1 || overlap < 0 || overlap >= size) throw new Error('Invalid chunk size or overlap');
  const content = String(document.content || '');
  const chunks = [];
  for (let start = 0; start < content.length;) {
    const end = Math.min(content.length, start + size);
    chunks.push({ document, startOffset: start, endOffset: end, content: content.slice(start, end) });
    if (end === content.length) break;
    start = end - overlap;
  }
  return chunks;
}

function counts(tokens) {
  const result = new Map();
  for (const token of tokens) result.set(token, (result.get(token) || 0) + 1);
  return result;
}
function cleanExcerpt(value, maxLength) {
  const excerpt = value.replace(/^#{1,6}\s+/gm, '').trim();
  return excerpt.length > maxLength ? `${excerpt.slice(0, maxLength)}…` : excerpt;
}

/** Rank chunks with BM25 and return the best chunk per document.
 * This is lexical retrieval, not an embedding or semantic index. */
export function searchKnowledge(documents, query, limit = 4) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || limit <= 0) return [];
  const chunks = documents.flatMap(document => chunkDocument(document).map(chunk => {
    const tokens = terms(chunk.content);
    return { ...chunk, tokens, frequencies: counts(tokens), title: new Set(tokenize(document.title)) };
  }));
  if (!chunks.length) return [];
  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / chunks.length || 1;
  const idf = new Map(queryTokens.map(token => {
    const frequency = chunks.filter(chunk => chunk.frequencies.has(token) || chunk.title.has(token)).length;
    return [token, Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  const bestByDocument = new Map();
  for (const chunk of chunks) {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = chunk.frequencies.get(token) || 0;
      const weight = idf.get(token);
      if (frequency) score += weight * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * chunk.tokens.length / averageLength));
      if (chunk.title.has(token)) score += weight * 1.5;
    }
    if (!score) continue;
    const previous = bestByDocument.get(chunk.document.id);
    if (!previous || score > previous.score) bestByDocument.set(chunk.document.id, {
      id: chunk.document.id, title: chunk.document.title,
      excerpt: cleanExcerpt(chunk.content, 620), score,
      startOffset: chunk.startOffset, endOffset: chunk.endOffset,
    });
  }
  return [...bestByDocument.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit).map(result => ({ ...result, score: Number(result.score.toFixed(3)) }));
}

/** Pick the strongest matching passage for display or a bounded document read. */
export function excerptFor(document, query, maxLength = 620) {
  const chunks = chunkDocument(document, { size: Math.max(200, maxLength), overlap: 120 });
  if (!chunks.length) return '';
  const queryTokens = tokenize(query);
  let best = chunks[0];
  let bestScore = -1;
  for (const chunk of chunks) {
    const tokenSet = new Set(tokenize(chunk.content));
    const score = queryTokens.reduce((sum, token) => sum + Number(tokenSet.has(token)), 0);
    if (score > bestScore) { best = chunk; bestScore = score; }
  }
  return cleanExcerpt(best.content, maxLength);
}
