export function identity(schema: string | undefined, ...names: string[]): string {
  return [...(schema ? [schema] : []), ...names]
    .map((name) => (/[."]/u.test(name) ? '"' + name.replaceAll('"', '""') + '"' : name))
    .join('.')
}
