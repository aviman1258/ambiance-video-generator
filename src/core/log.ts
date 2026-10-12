/** The subset of a pino logger the services use. Fastify's app.log satisfies it. */
export type Logger = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
