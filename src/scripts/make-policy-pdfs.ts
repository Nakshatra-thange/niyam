import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const DIR = "policies";
const PAGE = { w: 595, h: 842, margin: 56, size: 10, lead: 15 };

function wrap(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if ((cur + " " + word).trim().length > maxChars) {
      out.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) out.push(cur);
  return out;
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".txt"))) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = readFileSync(join(DIR, file), "utf8").split("=== PAGE BREAK ===");

  pages.forEach((text, pi) => {
    const page = pdf.addPage([PAGE.w, PAGE.h]);
    let y = PAGE.h - PAGE.margin;
    const lines = text.trim().split("\n").flatMap((l) => wrap(l, 95));
    lines.forEach((line, li) => {
      const isHeading = pi === 0 && li === 0;
      page.drawText(line, { x: PAGE.margin, y, size: isHeading ? 13 : PAGE.size, font: isHeading ? bold : font, color: rgb(0.1, 0.1, 0.1) });
      y -= isHeading ? PAGE.lead + 6 : PAGE.lead;
    });
    page.drawText(`Page ${pi + 1} of ${pages.length}  |  CONFIDENTIAL - FOR INTERNAL USE ONLY`, {
      x: PAGE.margin, y: 30, size: 8, font, color: rgb(0.5, 0.5, 0.5),
    });
  });

  const out = join(DIR, file.replace(/\.txt$/, ".pdf"));
  writeFileSync(out, await pdf.save());
  console.log(`✓ ${out} (${pages.length} pages)`);
}