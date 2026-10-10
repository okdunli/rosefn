
export type RoutePath = "/" | "/:lang/about" | "/about" | "/admin" | "/api/demo-auth" | "/api/demo-validate" | "/api/echo" | "/api/hello" | "/api/login" | "/api/posts" | "/api/secret" | "/bare" | "/bind-demo" | "/blog/:id" | "/broken" | "/buffered" | "/content-demo" | "/deftest" | "/docs" | "/else-demo" | "/feed" | "/fresh" | "/garden" | "/guarded" | "/island-demo" | "/kvdemo" | "/mirror404" | "/persist-demo" | "/search" | "/sign" | "/thorn" | "/vault";
export const routePatterns = ["/","/:lang/about","/about","/admin","/api/demo-auth","/api/demo-validate","/api/echo","/api/hello","/api/login","/api/posts","/api/secret","/bare","/bind-demo","/blog/:id","/broken","/buffered","/content-demo","/deftest","/docs","/else-demo","/feed","/fresh","/garden","/guarded","/island-demo","/kvdemo","/mirror404","/persist-demo","/search","/sign","/thorn","/vault"] as const;
export type RouteParams = {
  "/:lang/about": { lang: string | number };
  "/blog/:id": { id: string | number };

};
/** Build a URL from a route pattern and its params. */
export function url(
  path: RoutePath,
  params: RouteParams[keyof RouteParams] = {} as never,
): string {
  let out = path as string;
  for (const [k, v] of Object.entries(params as Record<string, string | number>)) {
    out = out.replace(new RegExp('[:*]+' + k, 'g'), String(v));
  }
  return out;
}
