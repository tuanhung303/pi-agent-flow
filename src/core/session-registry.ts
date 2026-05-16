/**
 * Session registry — maps cwd to the active sessionId.
 *
 * Replaces module-level singletons (_currentCwd, _currentSessionId) with a
 * single Map that is populated at session_start and consulted by event
 * handlers that do not receive ExtensionContext (e.g. turn_end).
 */

const registry = new Map<string, string>(); // cwd -> sessionId
let _lastCwd: string | undefined;

export function register(cwd: string, sessionId: string): void {
  registry.set(cwd, sessionId);
  _lastCwd = cwd;
}

export function unregister(cwd: string): void {
  registry.delete(cwd);
  if (_lastCwd === cwd) {
    _lastCwd = undefined;
  }
}

export function getSessionId(cwd: string): string | undefined {
  return registry.get(cwd);
}

/**
 * Returns the most recently registered cwd.
 * Used by turn_end handlers that lack ExtensionContext.
 */
export function getCwd(): string | undefined {
  return _lastCwd;
}
