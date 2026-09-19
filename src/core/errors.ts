/** ReVeil error type — carries a stable machine readable code for the bot + CLI. */
export class ReVeilError extends Error {
  readonly code: string;

  constructor(message: string, code = "REVEIL_ERROR") {
    super(message);
    this.name = "ReVeilError";
    this.code = code;
  }
}

export function fail(message: string, code?: string): never {
  throw new ReVeilError(message, code);
}
