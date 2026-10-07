export interface SettingsAnchor {
  id: string;
  after?: string;
}

export function placeSettingsSections<T extends SettingsAnchor>(base: readonly T[], sections: readonly T[]): T[] {
  const result: T[] = [];
  const placed = new Set<string>();
  const append = (page: T) => {
    if (placed.has(page.id)) return;
    placed.add(page.id);
    result.push(page);
    for (const section of sections) if (section.after === page.id) append(section);
  };
  for (const page of base) append(page);
  for (const section of sections) {
    if (!section.after || !sections.some(candidate => candidate.id === section.after)) append(section);
  }
  for (const section of sections) append(section);
  return result;
}
