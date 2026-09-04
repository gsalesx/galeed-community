/** Slug ASCII a partir de texto livre (remove acentos, normaliza separadores). */
const COMBINING = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(COMBINING, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sem-titulo"
  );
}
