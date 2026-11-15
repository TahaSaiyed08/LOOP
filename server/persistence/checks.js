// Relationship checks for the THESIS tables: name -> SQL returning the violating rows (any row = failure).
// Used by scripts/db-inspect.js --verify (real database, read-only) and by the offline persistence tests.
const CHECKS = {
  'chat message thesis/user = its conversation': `SELECT m.message_id FROM chat_messages m JOIN chat_conversations c USING (conversation_id)
     WHERE m.thesis_id <> c.thesis_id OR m.user_id <> c.user_id`,
  'conversation thesis belongs to the conversation user': `SELECT c.conversation_id FROM chat_conversations c JOIN theses t USING (thesis_id) WHERE t.user_id <> c.user_id`,
  'investigation match belongs to the conversation thesis': `SELECT c.conversation_id FROM chat_conversations c JOIN thesis_matches mm ON mm.match_id = c.match_id
     WHERE mm.thesis_id <> c.thesis_id`,
  'message seq is 1..n per conversation': `SELECT conversation_id FROM chat_messages GROUP BY conversation_id HAVING min(seq) <> 1 OR max(seq) <> count(*)`,
  'message times non-decreasing in seq order': `SELECT message_id FROM (SELECT message_id, created_at, lag(created_at) OVER (PARTITION BY conversation_id ORDER BY seq) AS prev
     FROM chat_messages) x WHERE prev IS NOT NULL AND created_at < prev`,
  'messages alternate user (odd seq) / assistant (even seq)': `SELECT message_id FROM chat_messages WHERE (seq % 2 = 1) <> (role = 'user')`,
  'messages not older than their conversation': `SELECT m.message_id FROM chat_messages m JOIN chat_conversations c USING (conversation_id) WHERE m.created_at < c.created_at`,
  'user messages carry no citations': `SELECT message_id FROM chat_messages WHERE role = 'user' AND jsonb_array_length(citations) > 0`,
  'every citation links to a stored match (matchId + articleId set)': `SELECT m.message_id FROM chat_messages m, jsonb_array_elements(m.citations) c
     WHERE c->>'matchId' IS NULL OR c->>'articleId' IS NULL OR NOT EXISTS (SELECT 1 FROM thesis_matches mm WHERE mm.match_id = c->>'matchId')`,
  'cited match belongs to the same thesis and user as the message': `SELECT m.message_id FROM chat_messages m, jsonb_array_elements(m.citations) c
     JOIN thesis_matches mm ON mm.match_id = c->>'matchId' JOIN theses t ON t.thesis_id = mm.thesis_id
     WHERE mm.thesis_id <> m.thesis_id OR t.user_id <> m.user_id`,
  'cited article = the match article, with the same URL and ticker': `SELECT m.message_id FROM chat_messages m, jsonb_array_elements(m.citations) c
     JOIN thesis_matches mm ON mm.match_id = c->>'matchId' JOIN news_articles a ON a.article_id = mm.article_id
     WHERE a.article_id <> c->>'articleId' OR a.url IS DISTINCT FROM NULLIF(c->>'url', '') OR upper(a.ticker) IS DISTINCT FROM upper(c->>'ticker')`,
  'segment citation numbers point at a citation of that message': `SELECT m.message_id FROM chat_messages m, jsonb_array_elements(m.segments) s, jsonb_array_elements(s->'citations') n
     WHERE (n)::text::int < 1 OR (n)::text::int > jsonb_array_length(m.citations)`,
  'notification user/thesis = its match thesis owner': `SELECT n.notification_id FROM notifications n JOIN thesis_matches mm USING (match_id) JOIN theses t ON t.thesis_id = mm.thesis_id
     WHERE n.thesis_id <> mm.thesis_id OR n.user_id <> t.user_id`,
  'notification status agrees with its timestamps': `SELECT notification_id FROM notifications WHERE (status = 'sent') <> (sent_at IS NOT NULL) OR (status = 'failed' AND failed_at IS NULL)`,
  'thesis session belongs to the same user': `SELECT t.thesis_id FROM theses t JOIN onboarding_sessions s USING (session_id) WHERE s.user_id <> t.user_id`,
  'session event user = session user': `SELECT e.event_id FROM session_events e JOIN onboarding_sessions s USING (session_id) WHERE e.user_id <> s.user_id`,
  'thesis data.id = thesis_id': `SELECT thesis_id FROM theses WHERE data->>'id' <> thesis_id`,
  'thesis has assumptions with challenge criteria': `SELECT thesis_id FROM theses WHERE origin = 'session' AND (jsonb_array_length(assumptions) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(assumptions) a WHERE coalesce(a->>'text', '') = ''))`,
  'checked-and-matched articles have a match row': `SELECT k.article_id FROM thesis_article_checks k LEFT JOIN thesis_matches mm
     ON k.thesis_id = mm.thesis_id AND k.article_id = mm.article_id AND k.assumption_version = mm.assumption_version WHERE k.matched AND mm.match_id IS NULL`,
  'assessment not before the article was ingested': `SELECT mm.match_id FROM thesis_matches mm JOIN news_articles a USING (article_id) WHERE mm.assessed_at < a.ingested_at`,
  'article last_seen >= ingested, seen_count >= 1': `SELECT article_id FROM news_articles WHERE last_seen_at < ingested_at OR seen_count < 1`,
};

async function runChecks(db) {
  const out = [];
  for (const [name, sql] of Object.entries(CHECKS)) out.push({ name, bad: (await db.query(sql)).rows });
  return out;
}

module.exports = { CHECKS, runChecks };
