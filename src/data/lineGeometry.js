const DEFAULT_TOLERANCE_DEG = 0.00003;
const DEFAULT_MAX_POINTS = 256;

function pointsClose(a, b, tolerance) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

/** Simplify lon/lat geometry while preserving its endpoints. */
export function simplifyLine(
  line,
  { tolerance = DEFAULT_TOLERANCE_DEG, maxPoints = DEFAULT_MAX_POINTS } = {},
) {
  if (!Array.isArray(line) || line.length <= 2) return line || [];
  const toleranceSquared = tolerance ** 2;
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = line[start];
    const b = line[end];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    let farthest = -1;
    let maximum = toleranceSquared;
    for (let index = start + 1; index < end; index += 1) {
      const point = line[index];
      const fraction = denominator
        ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator))
        : 0;
      const projected = [a[0] + fraction * dx, a[1] + fraction * dy];
      const distanceSquared =
        (point[0] - projected[0]) ** 2 + (point[1] - projected[1]) ** 2;
      if (distanceSquared > maximum) {
        maximum = distanceSquared;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const simplified = line.filter((_point, index) => keep[index]);
  if (simplified.length <= maxPoints) return simplified;
  const stride = (simplified.length - 1) / (maxPoints - 1);
  return Array.from(
    { length: maxPoints },
    (_value, index) => simplified[Math.round(index * stride)],
  );
}

/** Merge line fragments whose endpoints meet within a small tolerance. */
export function mergeConnectedLines(lines, tolerance = 1e-7) {
  const remaining = lines.map((line) => [...line]);
  const merged = [];
  while (remaining.length) {
    const current = remaining.pop();
    let joined = true;
    while (joined) {
      joined = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const candidate = remaining[index];
        if (pointsClose(current.at(-1), candidate[0], tolerance)) {
          current.push(...candidate.slice(1));
        } else if (pointsClose(current[0], candidate.at(-1), tolerance)) {
          current.unshift(...candidate.slice(0, -1));
        } else {
          continue;
        }
        remaining.splice(index, 1);
        joined = true;
        break;
      }
    }
    merged.push(simplifyLine(current));
  }
  return merged;
}
