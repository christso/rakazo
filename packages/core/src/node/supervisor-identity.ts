/** Stable managed container names, shared by the supervisor and remote transports. */
export function sanitizeComputerIdentifier(homeKey: string) {
  const safe = homeKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function supervisorComputerName(homeKey: string) {
  return `rakazo-bot-${sanitizeComputerIdentifier(homeKey)}`;
}
