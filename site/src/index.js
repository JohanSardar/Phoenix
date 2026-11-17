const repo = "https://github.com/JohanSardar/Phoenix";

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return Response.redirect(repo, 302);
    if (pathname !== "/install") return new Response("Not found\n", { status: 404 });
    const script = await fetch(`${repo}/releases/latest/download/install.sh`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!script.ok) return new Response("Could not fetch the Phoenix installer from GitHub Releases\n", { status: 502 });
    return new Response(script.body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" } });
  },
};
