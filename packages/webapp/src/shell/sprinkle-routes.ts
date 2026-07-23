// ── Sprinkle → scoop routing config (localStorage-backed) ──

const SPRINKLE_ROUTES_KEY = 'slicc-sprinkle-routes';

function loadRoutes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SPRINKLE_ROUTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRoutes(routes: Record<string, string>): void {
  try {
    localStorage.setItem(SPRINKLE_ROUTES_KEY, JSON.stringify(routes));
  } catch {
    /* localStorage full */
  }
}

/** Get the target scoop for a sprinkle, or undefined (→ cone). */
export function getSprinkleRoute(sprinkleName: string): string | undefined {
  return loadRoutes()[sprinkleName];
}

/** Set the target scoop for a sprinkle's lick events. */
export function setSprinkleRoute(sprinkleName: string, scoop: string): void {
  const routes = loadRoutes();
  routes[sprinkleName] = scoop;
  saveRoutes(routes);
}

/** Clear the target scoop for a sprinkle (reverts to cone). */
export function clearSprinkleRoute(sprinkleName: string): void {
  const routes = loadRoutes();
  delete routes[sprinkleName];
  saveRoutes(routes);
}

/** Get all sprinkle → scoop routes. */
export function getAllSprinkleRoutes(): Record<string, string> {
  return loadRoutes();
}
