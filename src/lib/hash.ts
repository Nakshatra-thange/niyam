import crypto from "node:crypto";

/** JSON.stringify with sorted keys, so {a,b} and {b,a} hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** ABCDE1234F -> ******234F. Never return a full PAN from the API. */
export const maskPan = (pan: string) => "*".repeat(Math.max(pan.length - 4, 0)) + pan.slice(-4);