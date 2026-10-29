const englishStopWords = new Set('a an and are as at be by can could do does for from how i in is it me my of on or please should tell that the their this to use using was what when where which who why will with would you your save note notes summarize summary'.split(' '));
const chineseFillers = /请问|请帮我|帮我|告诉我|什么是|是什么|为什么|怎么样|怎么|如何|一下|相关|有关|是否|可以|需要|应该|进行|总结|整理|保存|笔记|生成|回答|知识库|依据|根据|并且|以及|然后|这些|这个|一个/g;

/** Lightweight lexical retrieval, deliberately not an embedding/vector database. */
export function tokenize(text) {
  const cleaned = String(text).normalize('NFKC').toLowerCase().replace(chineseFillers, ' ');
  const tokens = (cleaned.match(/[a-z][a-z0-9_-]+/g) || []).filter(token => !englishStopWords.has(token));
  for (const phrase of cleaned.match(/[\p{Script=Han}]+/gu) || []) {
    if (phrase.length === 1) continue;
    for (let index = 0; index < phrase.length - 1; index++) tokens.push(phrase.slice(index, index + 2));
  }
  return [...new Set(tokens)];
}

function relevance(queryTokens, textTokens, weights) {
  let score = 0;
  for (const token of queryTokens) if (textTokens.has(token)) score += weights.get(token) || 1;
  return score;
}

export function excerptFor(document, query, maxLength = 620) {
  const queryTokens = tokenize(query);
  const paragraphs = document.content.split(/\n\s*\n/u).map(value => value.trim()).filter(value => value && !/^#{1,6}\s+[^\n]+$/u.test(value));
  let best = paragraphs[0] || document.content;
  let bestScore = -1;
  for (const paragraph of paragraphs) {
    const score = relevance(queryTokens, new Set(tokenize(paragraph)), new Map());
    if (score > bestScore) { best = paragraph; bestScore = score; }
  }
  const excerpt = best.replace(/^#{1,6}\s+/gm, '').trim();
  return excerpt.length > maxLength ? `${excerpt.slice(0, maxLength)}…` : excerpt;
}

export function searchKnowledge(documents, query, limit = 4) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const indexed = documents.map(document => ({ document, body: new Set(tokenize(document.content)), title: new Set(tokenize(document.title)) }));
  const weights = new Map(queryTokens.map(token => [token, 1 + Math.log(1 + indexed.length / (1 + indexed.filter(row => row.body.has(token) || row.title.has(token)).length))]));
  return indexed.map(({ document, body, title }) => ({
    id: document.id,
    title: document.title,
    excerpt: excerptFor(document, query),
    score: Number((relevance(queryTokens, body, weights) + 1.8 * relevance(queryTokens, title, weights)).toFixed(3)),
  })).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
