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
  } catch {}
}

export function getSprinkleRoute(sprinkleName: string): string | undefined {
  return loadRoutes()[sprinkleName];
}

export function setSprinkleRoute(sprinkleName: string, scoop: string): void {
  const routes = loadRoutes();
  routes[sprinkleName] = scoop;
  saveRoutes(routes);
}

export function clearSprinkleRoute(sprinkleName: string): void {
  const routes = loadRoutes();
  delete routes[sprinkleName];
  saveRoutes(routes);
}

export function getAllSprinkleRoutes(): Record<string, string> {
  return loadRoutes();
}
