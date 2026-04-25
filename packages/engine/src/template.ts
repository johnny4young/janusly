export function getByPath(source: any, path: string) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, source);
}

export function renderTemplate(value: any, scope: Record<string, any>): any {
  if (typeof value === 'string') {
    return value.replace(/{{\s*([^}]+)\s*}}/g, (_, rawPath) => {
      const resolved = getByPath(scope, String(rawPath).trim());

      if (resolved == null) return '';
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => renderTemplate(item, scope));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, scope)])
    );
  }

  return value;
}
