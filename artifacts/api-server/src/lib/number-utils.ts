export function humanizeNumber(value: number, isRatio = false): string {
  if (Number.isNaN(value)) return "—";
  const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  const str = rounded % 1 === 0
    ? Math.round(rounded).toLocaleString("en-IN")
    : rounded.toFixed(1);
  return isRatio ? `~${str}` : str;
}

export function humanizePct(value: number): string {
  const abs = Math.abs(value);
  const pct = Math.round(abs * 100);
  return `~${pct}%`;
}

export function formatRupees(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}
