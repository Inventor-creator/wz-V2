export function groupBy<T>(
  values: T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value);
    const group = groups.get(k) || [];
    group.push(value);
    groups.set(k, group);
  }
  return groups;
}
