/** Metadata for a PDF selected in the current task. */
export type SourceFile = {
  name: string;
  relativePath: string;
  size: number;
  path?: string;
};

export type SearchMode = 'exact' | 'fuzzy';
