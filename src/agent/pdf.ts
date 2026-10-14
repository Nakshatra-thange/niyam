import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Returns the document's text, one string per page (index 0 = page 1).
 * Per-page text matters: every rule the agent extracts must cite a page,
 * and the validator checks the quote really is on that page.
 */
export async function extractPages(path: string): Promise<string[]> {
  if (path.endsWith(".txt")) {
    const raw = await readFile(path, "utf8");
    return raw.split("=== PAGE BREAK ===").map((p) => p.trim());
  }
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((p) => p.trim());
  if (pages.every((p) => p.length < 20)) {
    throw new Error(`${path}: no extractable text. Scanned PDF? It would need OCR first.`);
  }
  return pages;
}