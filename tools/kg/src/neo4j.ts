import neo4j, { type Driver, type Session } from "neo4j-driver";

/**
 * Driver factory. disableLosslessIntegers is REQUIRED on every driver in this
 * tool: relationship `order` properties must round-trip as plain JS numbers —
 * the default lossless {low, high} Integer objects would corrupt export
 * sorting and JSON output.
 */
export function createDriver(uri: string, user: string, password: string): Driver {
  return neo4j.driver(uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true,
  });
}

export async function withSession<T>(driver: Driver, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = driver.session();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Labels and relationship types are interpolated into Cypher (they cannot be
 * parameterized). Only identifiers matching this shape are ever accepted —
 * everything else aborts, so backtick-quoting below can never be escaped. */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe graph identifier rejected: ${JSON.stringify(name)}`);
  }
  return name;
}

export function quoteIdentifier(name: string): string {
  return "`" + assertSafeIdentifier(name) + "`";
}

export async function verifyConnectivity(driver: Driver, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await driver.getServerInfo();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`cannot reach ${what} within ${timeoutMs / 1000}s: ${String(lastError)}`);
}
