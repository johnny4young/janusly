export function getSecret(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing secret: ${name}`);
  }

  return value;
}

export function listSecretRefs(value: any): string[] {
  const refs = new Set<string>();

  function visit(input: any) {
    if (typeof input === "string") {
      for (const match of input.matchAll(/{{\s*secret\.([A-Z0-9_]+)\s*}}/gi)) {
        refs.add(match[1]);
      }
      return;
    }

    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }

    if (typeof input === "object" && input !== null) {
      Object.values(input).forEach(visit);
    }
  }

  visit(value);
  return Array.from(refs);
}

export function maskSecrets(value: any): any {
  if (typeof value === "string") {
    return value.replace(/{{\s*secret\.([A-Z0-9_]+)\s*}}/gi, "{{secret.$1}}");
  }

  if (Array.isArray(value)) {
    return value.map(maskSecrets);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item)]));
  }

  return value;
}
