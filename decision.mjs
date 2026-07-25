/**
 * Parsing and validation of a review decision.
 *
 * QA C4. The previous behaviour took the last comment on a closed issue as the
 * recorded outcome, so a colleague replying "+1" after a proper assessment
 * became the permanent audit record of a regulatory decision.
 *
 * A decision is now a structured block. Free prose is still welcome around it,
 * but only the block is the record.
 */

export const VALID_DECISIONS = ['no-change', 'change-required', 'already-covered', 'not-applicable', 'superseded'];

export const TEMPLATE = [
  '```decision',
  'DECISION: change-required',
  'SECTIONS: 4.4.6, 3.10.1',
  'ARTEFACTS: DPIA Template',
  'IN-FORCE: 2026-10-01',
  'NOTE: one or two sentences on why, and what has to change.',
  '```'
].join('\n');

/**
 * Pulls the decision block out of a comment body. Returns null when the comment
 * carries no decision, which is how "+1" is correctly ignored.
 */
export function parseDecision(body) {
  if (!body) return null;

  const fenced = body.match(/```\s*decision\s*\n([\s\S]*?)```/i);
  // Accept an unfenced block too, so a reviewer who forgets the backticks is
  // not punished for it. DECISION: on its own line is enough.
  const raw = fenced ? fenced[1] : (/^\s*DECISION\s*:/im.test(body) ? body : null);
  if (!raw) return null;

  const field = (name) => {
    const m = raw.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : null;
  };

  const decision = (field('DECISION') || '').toLowerCase().replace(/\s+/g, '-').replace(/[.,;]+$/, '');
  if (!decision) return null;

  const list = (v) => (v ? v.split(/[,;]/).map((s) => s.trim().replace(/^§/, '')).filter(Boolean) : []);
  const inForce = field('IN-FORCE') || field('IN FORCE');

  const errors = [];
  if (!VALID_DECISIONS.includes(decision)) errors.push(`DECISION must be one of: ${VALID_DECISIONS.join(', ')}. Got "${decision}".`);
  const note = field('NOTE');
  if (!note || note.length < 10) errors.push('NOTE is required and must say something. One sentence is enough.');
  if (decision === 'change-required' && !list(field('ARTEFACTS')).length && !list(field('SECTIONS')).length) {
    errors.push('change-required must name at least one SECTION or ARTEFACT.');
  }
  if (inForce && !/^\d{4}-\d{2}-\d{2}$/.test(inForce)) errors.push('IN-FORCE must be YYYY-MM-DD.');

  return {
    decision,
    sections: list(field('SECTIONS')),
    artefacts: list(field('ARTEFACTS')),
    in_force: inForce,
    note: note ?? null,
    valid: errors.length === 0,
    errors
  };
}

/**
 * Picks the decision from a comment thread: the last comment that parses as
 * one, not the last comment. Later commentary cannot overwrite the record
 * unless it is itself a decision.
 */
export function decisionFromComments(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.user?.type === 'Bot') continue;
    const d = parseDecision(c.body);
    if (d) return { ...d, author: c.user?.login ?? null, at: c.created_at ?? null };
  }
  return null;
}

/** QA M5. Who decided, in what capacity, and were they entitled to. */
export function authorityFor(login, reviewersFile) {
  const r = (reviewersFile?.reviewers ?? []).find((x) => x.github?.toLowerCase() === String(login ?? '').toLowerCase());
  if (!r) return { known: false, role: null, can_approve: false };
  return { known: true, role: r.role ?? null, name: r.name ?? null, can_approve: !!r.can_approve };
}
