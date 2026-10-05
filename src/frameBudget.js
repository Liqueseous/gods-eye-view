const DEFAULT_FRAME_BUDGET_MS = 12;
const FRAME_WINDOW_MS = 1000 / 60;

let current = null;

function normalizedToken(token, now) {
  return Number.isFinite(token) ? token : Math.floor(now / FRAME_WINDOW_MS);
}

export function beginSharedFrameBudget(
  frameToken,
  budgetMs = DEFAULT_FRAME_BUDGET_MS,
) {
  const now = globalThis.performance?.now?.() || 0;
  const token = normalizedToken(frameToken, now);
  if (!current || current.token !== token) {
    current = {
      token,
      startedAt: now,
      budgetMs: Math.max(1, Number(budgetMs) || DEFAULT_FRAME_BUDGET_MS),
      owners: new Map(),
    };
  }
  return current;
}

export function sharedFrameBudgetAllows(reserveMs = 0) {
  if (!current) return true;
  const now = globalThis.performance?.now?.() || current.startedAt;
  return now - current.startedAt + Math.max(0, reserveMs) <= current.budgetMs;
}

export function recordSharedFrameBudget(owner, elapsedMs) {
  if (!current || !owner) return;
  const entry = current.owners.get(owner) || { calls: 0, elapsedMs: 0 };
  entry.calls += 1;
  entry.elapsedMs += Math.max(0, Number(elapsedMs) || 0);
  current.owners.set(owner, entry);
}

export function getSharedFrameBudgetDiagnostics() {
  if (!current) return null;
  const now = globalThis.performance?.now?.() || current.startedAt;
  return {
    budgetMs: current.budgetMs,
    elapsedMs: now - current.startedAt,
    owners: Object.fromEntries(
      [...current.owners].map(([owner, value]) => [owner, { ...value }]),
    ),
  };
}

export function resetSharedFrameBudgetForTest() {
  current = null;
}

export { DEFAULT_FRAME_BUDGET_MS };
