/**
 * Where the client reports retries, rate-limit waits, and connection changes.
 *
 * Nothing the client passes here ever holds a credential: fields are paths, statuses, counts, and
 * delays. The default is silent so tests and scripts stay quiet; the engine passes its own.
 */
export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const ignore = (): void => undefined;

export const silentLogger: Logger = { debug: ignore, info: ignore, warn: ignore, error: ignore };
