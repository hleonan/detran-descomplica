/**
 * certidaoParser.js
 * - Extrai texto do PDF da certidão do DETRAN-RJ
 * - Retorna texto bruto e texto normalizado (pra fazer regras)
 */

import fs from "fs/promises";
import path from "path";
import pdf from "pdf-parse";

/**
 * Normaliza texto pra facilitar regras:
 * - uppercase
 * - remove acentos
 * - remove espaços duplicados
 */
export function normalizeText(input = "") {
  return input
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // tira acentos
    .replace(/[^\S\r\n]+/g, " ")     // espaços repetidos
    .replace(/\n{3,}/g, "\n\n")      // muitas quebras vira 2
    .trim()
    .toUpperCase();
}

/**
 * Extrai texto a partir de um Buffer de PDF
 */
export async function extractCertidaoTextFromBuffer(pdfBuffer) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error("extractCertidaoTextFromBuffer: pdfBuffer inválido");
  }

  const data = await pdf(pdfBuffer);

  const rawText = (data?.text || "").trim();
  const normalizedText = normalizeText(rawText);

  return {
    rawText,
    normalizedText,
    meta: {
      pages: data?.numpages ?? null,
      info: data?.info ?? null,
    },
  };
}

/**
 * Extrai texto a partir de um arquivo PDF no disco
 */
export async function extractCertidaoTextFromFile(pdfFilePath) {
  if (!pdfFilePath) throw new Error("extractCertidaoTextFromFile: caminho vazio");

  const resolved = path.resolve(pdfFilePath);

  const pdfBuffer = await fs.readFile(resolved);
  return extractCertidaoTextFromBuffer(pdfBuffer);
}
