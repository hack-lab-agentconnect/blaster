import { httpRouter } from "convex/server";
import { registerBlasterRoutes } from "./http/blaster.js";

/**
 * Blaster's read-only HTTP routes.
 *
 * This file registers route groups and handles nothing itself; each domain's
 * routes live in http/<domain>.ts. See docs/convex-naming-conventions.md
 * (rule R7).
 */
const http = httpRouter();

registerBlasterRoutes(http);

export default http;
