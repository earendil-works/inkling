const domainPattern =
  /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;

export function parseAllowedGoogleDomains(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((domain) => domain.trim().replace(/^@/u, "").toLocaleLowerCase("en"))
        .filter((domain) => domainPattern.test(domain)),
    ),
  ];
}

export function isGoogleEmailAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return false;
  const domain = email.slice(separator + 1).toLocaleLowerCase("en");
  return allowedDomains.includes(domain);
}
