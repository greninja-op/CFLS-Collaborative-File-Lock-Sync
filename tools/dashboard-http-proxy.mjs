import http from "node:http";
import https from "node:https";

const listenPort = Number(process.env.CFLS_DASHBOARD_PROXY_PORT ?? "18730");

const proxy = http.createServer((request, response) => {
  const upstream = https.request(
    {
      hostname: "127.0.0.1",
      port: 8730,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: "127.0.0.1:8730" },
      rejectUnauthorized: false,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Unable to reach the local CFLS Host.");
  });
  request.pipe(upstream);
});

proxy.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `Dashboard verification proxy listening on http://127.0.0.1:${listenPort}`,
  );
});
