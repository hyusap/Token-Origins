/** Keep local conversation and execution tools reachable only from this project's browser origins. */
export function requestAccess(
  request: Request,
  port = Number(process.env.PORT || 4318),
) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  if (!/^(?:127\.0\.0\.1|localhost)(?::[0-9]+)?$/i.test(host))
    return {
      allowed: false,
      reason: "Only localhost hosts are accepted",
      corsHeaders: {},
    };
  const origin = request.headers.get("origin");
  const apiOrSocket =
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/ws";
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  if (apiOrSocket && origin && !allowedOrigins.has(origin))
    return {
      allowed: false,
      reason: "Browser origin is not authorized for local canvas access",
      corsHeaders: {},
    };
  const corsHeaders: Record<string, string> = {};
  if (origin && allowedOrigins.has(origin)) {
    corsHeaders["Access-Control-Allow-Origin"] = origin;
    corsHeaders["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    corsHeaders["Access-Control-Allow-Headers"] = "Content-Type";
    corsHeaders["Vary"] = "Origin";
  }
  return { allowed: true, corsHeaders };
}
